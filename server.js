// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

// Initialize Express app
const app = express();
app.use(cors());
app.use(express.json());

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.IO with improved configuration
const io = new Server(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true
  },

  
  transports: ['websocket', 'polling'], // Prioritize WebSocket
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
  path: '/socket.io',
  // This helps with proxy environments
  cookie: false, // Increase ping timeout to 60 seconds // More frequent pings to detect disconnections earlier
  connectTimeout: 30000, // Longer connect timeout
  maxHttpBufferSize: 1e8 // Increase buffer size for larger messages
});



// Initialize Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Store active rooms with improved tracking
const rooms = new Map();

// Helper to log with timestamps
const logWithTimestamp = (message) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
};

// Generate a 6-digit room code
function generateRoomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Translate text using Gemini API with retry mechanism
async function translateText(text, fromLang, toLang) {
  const maxRetries = 3;
  let retries = 0;
  
  while (retries < maxRetries) {
    try {
      const model = genAI.getGenerativeModel({ model: "gemini-pro" });
      
      const prompt = `Translate the following text from ${fromLang} to ${toLang}. 
      Return only the translated text without any explanations:
      "${text}"`;
      
      const result = await model.generateContent(prompt);
      const translation = result.response.text();
      
      return translation.trim();
    } catch (error) {
      retries++;
      logWithTimestamp(`Translation error (attempt ${retries}/${maxRetries}): ${error.message}`);
      
      if (retries >= maxRetries) {
        return `[Translation unavailable: ${error.message}]`;
      }
      
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, 1000 * retries));
    }
  }
}

// API endpoint to create a new room
app.post('/api/create-room', (req, res) => {
  const { translationDirection } = req.body;
  const roomCode = generateRoomCode();
  
  rooms.set(roomCode, {
    translationDirection,
    users: [],
    createdAt: new Date(),
    lastActivity: new Date()
  });
  
  logWithTimestamp(`Created room ${roomCode} with direction ${translationDirection}`);
  res.json({ roomCode });
});

// API endpoint to check if a room exists
app.get('/api/check-room/:roomCode', (req, res) => {
  const { roomCode } = req.params;
  const roomExists = rooms.has(roomCode);
  
  res.json({ exists: roomExists });
});

// Socket.IO connection handler
io.on('connection', (socket) => {
  logWithTimestamp(`Client connected: ${socket.id}`);
  
  // Keep track of which room this socket is in
  let currentRoom = null;
  
  // Handle joining room
  socket.on('join-room', ({ roomCode, userName }) => {
    logWithTimestamp(`User ${userName} (${socket.id}) trying to join room ${roomCode}`);
    const room = rooms.get(roomCode);
    
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    
    // Add user to room
    socket.join(roomCode);
    currentRoom = roomCode;
    
    // Check if user already exists (potential reconnection)
    const existingUserIndex = room.users.findIndex(user => user.name === userName);
    if (existingUserIndex !== -1) {
      // Update the existing user's socket ID
      room.users[existingUserIndex].id = socket.id;
      logWithTimestamp(`User ${userName} reconnected with new socket ID ${socket.id}`);
    } else {
      // Add new user
      room.users.push({ id: socket.id, name: userName });
    }
    
    // Update room activity timestamp
    room.lastActivity = new Date();
    
    socket.emit('room-joined', { 
      roomCode, 
      translationDirection: room.translationDirection,
      users: room.users
    });
    
    // Notify room about new/reconnected user
    io.to(roomCode).emit('user-joined', { 
      userId: socket.id, 
      userName, 
      users: room.users 
    });

    socket.on('disconnect', (reason) => {
        console.log(`Client ${socket.id} disconnected. Reason: ${reason}`);
      });
    
    logWithTimestamp(`User ${userName} joined room ${roomCode}. Total users: ${room.users.length}`);
  });
  
  // Handle ping/heartbeat to detect connection issues
  socket.on('heartbeat', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (room) {
      room.lastActivity = new Date();
      socket.emit('heartbeat-ack');
    }
  });
  
  // Handle speech data
  socket.on('speech-data', async ({ roomCode, text }) => {
    logWithTimestamp(`Received speech data in room ${roomCode} from ${socket.id}: "${text.substring(0, 30)}${text.length > 30 ? '...' : ''}"`);
    const room = rooms.get(roomCode);
    
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    
    // Update room activity timestamp
    room.lastActivity = new Date();
    
    // Determine source and target languages
    let fromLang, toLang;
    if (room.translationDirection === 'en-to-hi') {
      fromLang = 'English';
      toLang = 'Hindi';
    } else {
      fromLang = 'Hindi';
      toLang = 'English';
    }
    
    try {
      // Translate the text
      const translatedText = await translateText(text, fromLang, toLang);
      logWithTimestamp(`Translated text: "${translatedText.substring(0, 30)}${translatedText.length > 30 ? '...' : ''}"`);
      
      // Send translated text to all users in the room except sender
      socket.to(roomCode).emit('translated-speech', { 
        originalText: text,
        translatedText,
        userId: socket.id
      });
    } catch (error) {
      logWithTimestamp(`Translation processing error: ${error}`);
      socket.emit('error', { message: 'Translation failed. Please try again.' });
    }
  });
  
  // Handle client connection status
  socket.on('connection-status', ({ roomCode, status }) => {
    logWithTimestamp(`Client ${socket.id} reported status: ${status} in room ${roomCode}`);
  });
  
  // Handle disconnect
  socket.on('disconnect', (reason) => {
    logWithTimestamp(`Client disconnected: ${socket.id}. Reason: ${reason}`);
    
    // Remove user from room they were in
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      
      if (room) {
        const userIndex = room.users.findIndex(user => user.id === socket.id);
        
        if (userIndex !== -1) {
          const user = room.users[userIndex];
          
          // Don't remove user immediately to allow for reconnection
          // Instead, mark as inactive for potential reconnection
          setTimeout(() => {
            // Check if the user has reconnected with a new socket ID
            const reconnected = room.users.some(u => 
              u.name === user.name && u.id !== socket.id
            );
            
            if (!reconnected) {
              // Remove user if they haven't reconnected
              room.users.splice(userIndex, 1);
              
              // Notify room
              io.to(currentRoom).emit('user-left', { 
                userId: socket.id, 
                userName: user.name,
                users: room.users 
              });
              
              logWithTimestamp(`User ${user.name} permanently left room ${currentRoom}`);
              
              // Clean up empty rooms after some time
              if (room.users.length === 0) {
                setTimeout(() => {
                  if (rooms.get(currentRoom)?.users.length === 0) {
                    rooms.delete(currentRoom);
                    logWithTimestamp(`Room ${currentRoom} deleted due to inactivity`);
                  }
                }, 300000); // 5 minutes
              }
            }
          }, 20000); // Wait 20 seconds for potential reconnection
        }
      }
    }
  });
});

// Room cleanup process (runs every 30 minutes)
setInterval(() => {
  const now = new Date();
  for (const [roomCode, room] of rooms.entries()) {
    const inactiveTime = now - room.lastActivity;
    
    // Clean up rooms inactive for more than 1 hour
    if (inactiveTime > 3600000 && room.users.length === 0) {
      rooms.delete(roomCode);
      logWithTimestamp(`Room ${roomCode} deleted due to extended inactivity (${Math.floor(inactiveTime/60000)} minutes)`);
    }
  }
}, 1800000);

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  logWithTimestamp(`Server running on port ${PORT}`);
});