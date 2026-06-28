require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');
const rateLimit = require('express-rate-limit');

const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const JWT_SECRET = process.env.JWT_SECRET || "matchyap_super_secret_key_2026";

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: "Too many attempts. Please try again in 15 minutes." }
});

async function verifyCaptcha(token) {
    try {
        const secret = '6Lc9BhItAAAAAB6tWxo-Z6s0WUhsLNk_TkDIbmsT';
        const response = await axios.post(
            `https://www.google.com/recaptcha/api/siteverify?secret=${secret}&response=${token}`
        );
        return response.data.success;
    } catch (err) {
        console.error("Captcha API error:", err);
        return false;
    }
}

const onlineUsers = new Map();


app.post('/api/register', async (req, res) => {
  const { username, password, captcha } = req.body; 
  try {
    const isHuman = await verifyCaptcha(captcha);
    if (!isHuman) return res.status(400).json({ error: "Captcha verification failed." });

    const existingUser = await prisma.user.findFirst({ where: { username } });
    if (existingUser) return res.status(400).json({ error: "Username already exists." });
    
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    
    const dummyEmail = `${username}_${Date.now()}@matchyap.local`;

    await prisma.user.create({ data: { email: dummyEmail, username, passwordHash, avatar: username } });
    res.status(201).json({ message: "Account created!" });
  } catch (err) { 
    console.error("Registration error:", err);
    res.status(500).json({ error: "Server error." }); 
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password, captcha } = req.body; 
  try {
    const isHuman = await verifyCaptcha(captcha);
    if (!isHuman) return res.status(400).json({ error: "Captcha verification failed." });

    const user = await prisma.user.findUnique({ where: { username } }); 
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) 
      return res.status(400).json({ error: "Invalid username or password." });
    
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '1d' });
    res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar } });
  } catch (err) { 
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error." }); 
  }
});


app.put('/api/user/settings', async (req, res) => {
  const { userId, newUsername, newPassword, newAvatar } = req.body;

  if (!userId) return res.status(400).json({ error: "User ID is required." });

  try {
    const updateData = {};
    if (newUsername && newUsername.trim() !== '') updateData.username = newUsername;
    if (newAvatar && newAvatar.trim() !== '') updateData.avatar = newAvatar;
    if (newPassword && newPassword.trim() !== '') {
      const salt = await bcrypt.genSalt(10);
      updateData.passwordHash = await bcrypt.hash(newPassword, salt);
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: { id: true, username: true, email: true, avatar: true }
    });

    res.json({ success: true, message: "Settings updated!", user: updatedUser });
  } catch (err) {
    res.status(500).json({ error: "Failed to update profile settings." });
  }
});

app.get('/api/dashboard/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const matches = await prisma.match.findMany({ where: { OR: [{ initiatorId: userId }, { receiverId: userId }] } });
    const privateMatchRecords = matches.filter(m => m.connectionScore === 100);
    const rawPartnerIds = privateMatchRecords.map(m => m.initiatorId === userId ? m.receiverId : m.initiatorId).filter(id => id);
    const uniquePartnerIds = [...new Set(rawPartnerIds)];

    const privateMatches = await prisma.user.findMany({
      where: { id: { in: uniquePartnerIds } },
      select: { id: true, username: true, avatar: true }
    });

    const matchesWithStatus = privateMatches.map(user => ({
      ...user,
      isOnline: onlineUsers.has(String(user.id))
    }));

    res.json({ totalMatches: matchesWithStatus.length, privateMatches: matchesWithStatus });
  } catch (err) { res.status(500).json({ error: "Failed to fetch stats." }); }
});

app.post('/api/match/save', async (req, res) => {
  const { initiatorId, receiverId, connectionScore, sparkFelt } = req.body;
  if (!initiatorId || !receiverId || initiatorId === 'anonymous' || receiverId === 'anonymous') return res.status(200).json({ message: "Anonymous match skipped." });
  try {
    if (connectionScore === 100) {
      const existingMatch = await prisma.match.findFirst({
        where: { OR: [{ initiatorId, receiverId, connectionScore: 100 }, { initiatorId: receiverId, receiverId: initiatorId, connectionScore: 100 }] }
      });
      if (existingMatch) return res.status(200).json({ message: "Match already recorded." });
    }
    const newMatch = await prisma.match.create({ data: { initiatorId, receiverId, connectionScore, sparkFelt } });
    res.status(201).json(newMatch);
  } catch (err) { res.status(500).json({ error: "Failed to save match." }); }
});

app.post('/api/report', async (req, res) => {
  try {
    const { reporterId, reportedId, screenshot, reason } = req.body;

    if (!reporterId || !reportedId || !screenshot) {
      return res.status(400).json({ error: 'Missing required report data.' });
    }

    const newReport = await prisma.report.create({
      data: {
        reporterId,
        reportedId,
        screenshot,
        reason
      }
    });

    res.status(200).json({ success: true, message: 'Report filed successfully.', reportId: newReport.id });
  } catch (err) {
    console.error("Failed to save report:", err);
    res.status(500).json({ error: 'Internal server error while filing report.' });
  }
});

app.delete('/api/match/remove', async (req, res) => {
  const { userId, partnerId } = req.body;
  try {
    await prisma.match.deleteMany({
      where: { OR: [{ initiatorId: userId, receiverId: partnerId }, { initiatorId: partnerId, receiverId: userId }] }
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Failed to remove match." }); }
});

app.get('/api/messages/:userId/:partnerId', async (req, res) => {
  const { userId, partnerId } = req.params;
  try {
    const messages = await prisma.directMessage.findMany({
      where: { OR: [{ senderId: userId, receiverId: partnerId }, { senderId: partnerId, receiverId: userId }] },
      orderBy: { createdAt: 'asc' }
    });
    res.json(messages);
  } catch (err) { res.status(500).json({ error: "Failed to load messages" }); }
});

app.post('/api/messages', async (req, res) => {
  const { senderId, receiverId, text } = req.body;
  try {
    const msg = await prisma.directMessage.create({ data: { senderId, receiverId, text } });
    res.status(201).json(msg);
  } catch (err) { res.status(500).json({ error: "Failed to send message" }); }
});


// --- SOCKET.IO REAL-TIME SERVER ---
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

let waitingUsers = []; 

io.on('connection', (socket) => {

  socket.on('register-user', (userId) => {
    const strId = String(userId);
    socket.userId = strId;

    if (!onlineUsers.has(strId)) {
      onlineUsers.set(strId, new Set());
      io.emit('user-status-changed', { userId: strId, status: 'online' }); 
    }
    onlineUsers.get(strId).add(socket.id);
  });

  socket.on('call-user', ({ callerId, receiverId }) => {
    const strReceiver = String(receiverId);
    if (onlineUsers.has(strReceiver)) {
      onlineUsers.get(strReceiver).forEach(socketId => {
        io.to(socketId).emit('incoming-call', { callerId });
      });
    } else {
      socket.emit('call-failed', { message: 'User is offline.' });
    }
  });

  socket.on('accept-call', ({ callerId, receiverId }) => {
    const roomId = `private_${callerId}_${receiverId}`;
    socket.join(roomId); 
    
    const strCaller = String(callerId);
    if (onlineUsers.has(strCaller)) {
      onlineUsers.get(strCaller).forEach(socketId => {
        io.to(socketId).emit('call-accepted', { roomId, role: 'initiator' });
      });
    }
    socket.emit('call-accepted', { roomId, role: 'receiver' });
  });

  socket.on('join-private-room', (roomId) => socket.join(roomId));

  socket.on('decline-call', ({ callerId }) => {
    const strCaller = String(callerId);
    if (onlineUsers.has(strCaller)) {
      onlineUsers.get(strCaller).forEach(socketId => io.to(socketId).emit('call-declined'));
    }
  });

  socket.on('send-private-message', (data) => {
    const strReceiver = String(data.receiverId);
    if (onlineUsers.has(strReceiver)) {
      onlineUsers.get(strReceiver).forEach(socketId => {
        io.to(socketId).emit('receive-private-message', data);
      });
    }
  });

  const broadcastToRoom = (event, data) => {
    const rooms = Array.from(socket.rooms);
    const targetRoom = rooms.find(room => room !== socket.id); 
    if (targetRoom) socket.to(targetRoom).emit(event, data);
  };

  socket.on('webrtc-offer', (data) => broadcastToRoom('webrtc-offer', data));
  socket.on('webrtc-answer', (data) => broadcastToRoom('webrtc-answer', data));
  socket.on('webrtc-ice-candidate', (data) => broadcastToRoom('webrtc-ice-candidate', data));
  socket.on('send-message', (data) => broadcastToRoom('receive-message', { text: data.text, sender: 'remote' }));
  socket.on('update-connection-score', (data) => broadcastToRoom('score-synchronized', { newScore: data.newScore }));

  socket.on('leave-room', () => {
    broadcastToRoom('partner-disconnected'); 
    
    Array.from(socket.rooms).forEach(room => {
      if (room !== socket.id && !room.startsWith('user_')) {
        socket.leave(room);
      }
    });
  });

  socket.on('disconnecting', () => {
    broadcastToRoom('partner-disconnected');
  });

  socket.on('join-queue', (data) => {
    const userTags = data?.tags || ['random'];
    const userFallback = data?.fallback || false;
    const userId = data?.userId || null;
    if (!waitingUsers.some(u => u.id === socket.id)) {
      waitingUsers.push({ id: socket.id, tags: userTags, fallback: userFallback, userId });
      tryMatchUsers();
    }
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      const userSockets = onlineUsers.get(socket.userId);
      if (userSockets) {
        userSockets.delete(socket.id);
        if (userSockets.size === 0) {
          onlineUsers.delete(socket.userId);
          io.emit('user-status-changed', { userId: socket.userId, status: 'offline' });
        }
      }
    }
    waitingUsers = waitingUsers.filter(u => u.id !== socket.id);
  });

  function tryMatchUsers() {
    if (waitingUsers.length < 2) return;
    for (let i = 0; i < waitingUsers.length; i++) {
      for (let j = i + 1; j < waitingUsers.length; j++) {
        const userA = waitingUsers[i], userB = waitingUsers[j];
        const sharedTags = userA.tags.filter(tag => userB.tags.includes(tag));
        
        if (sharedTags.length > 0 || ((userA.tags.includes('random') || userA.fallback) && (userB.tags.includes('random') || userB.fallback))) {
          const matchedOn = sharedTags.length > 0 ? sharedTags[0] : 'Random';
          waitingUsers.splice(j, 1);
          waitingUsers.splice(i, 1);

          const matchRoomId = `room_${userA.id}_${userB.id}`;
          const socketA = io.sockets.sockets.get(userA.id);
          const socketB = io.sockets.sockets.get(userB.id);

          if (socketA && socketB) {
            socketA.join(matchRoomId);
            socketB.join(matchRoomId);
            socketA.emit('match-found', { room: matchRoomId, role: 'initiator', matchedOn, partnerId: userB.userId });
            socketB.emit('match-found', { room: matchRoomId, role: 'receiver', matchedOn, partnerId: userA.userId });
          }
          return tryMatchUsers();
        }
      }
    }
  }
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`MatchYap Server running on port ${PORT}`);
});