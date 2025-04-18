// test-server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['polling', 'websocket']
});

app.get('/', (req, res) => {
  res.send('Server is running');
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
  
  socket.on('test-event', (data) => {
    console.log('Received test event:', data);
    socket.emit('test-response', { message: 'Server received your test' });
  });
});

const PORT = 5000;
server.listen(PORT, () => {
  console.log(`Test server running on port ${PORT}`);
});