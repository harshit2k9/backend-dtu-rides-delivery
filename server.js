const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const nodemailer = require('nodemailer');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH"]
  }
});

app.use(cors());
app.use(express.json());

const transporter = nodemailer.createTransport({
  host: 'smtp.mailersend.net',
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// --- REST API: AUTH & OTP ---
app.get('/', (req, res) => {
  res.status(200).json({ status: 'DTU Route & Cart Backend is live!' });
});

app.post('/api/auth/send-otp', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email address is required.' });
  }

  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  try {
    await prisma.otpVerification.upsert({
      where: { email },
      update: { otp, expiresAt },
      create: { email, otp, expiresAt },
    });

    await transporter.sendMail({
      from: `"DTU Route & Cart" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Your DTU Secure OTP Code',
      text: `Your verification code is: ${otp}. Expires in 5 minutes.`,
    });

    return res.status(200).json({ message: 'OTP sent successfully to email.' });
  } catch (error) {
    console.error('[Email OTP Error]:', error);
    return res.status(500).json({ error: 'Failed to send OTP email.' });
  }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  try {
    const record = await prisma.otpVerification.findUnique({ where: { email } });
    if (!record || record.otp !== otp || new Date() > record.expiresAt) {
      return res.status(400).json({ error: 'Invalid or expired OTP.' });
    }

    await prisma.otpVerification.delete({ where: { email } });

    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await prisma.user.create({
        data: { email, fullName: email.split('@')[0], branch: 'COE', batchYear: 2026 },
      });
    }

    return res.status(200).json({ message: 'Verified successfully!', user });
  } catch (error) {
    console.error('[Verify OTP Error]:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// --- REST API: RIDES & RATINGS ---
app.get('/api/rides/active', async (req, res) => {
  try {
    const rides = await prisma.ride.findMany({
      where: { status: 'open' },
      include: { host: { select: { fullName: true, branch: true, reputationScore: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return res.status(200).json(rides);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch rides.' });
  }
});

app.post('/api/ratings', async (req, res) => {
  const { rideId, raterId, rateeId, score, comment } = req.body;
  if (!score || score < 1 || score > 5) return res.status(400).json({ error: 'Invalid score.' });

  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.rating.create({ data: { rideId: rideId || null, raterId, rateeId, score, comment } });
      const rateeRatings = await tx.rating.findMany({ where: { rateeId }, select: { score: true } });
      const sum = rateeRatings.reduce((acc, curr) => acc + curr.score, 0);
      const newAverage = Number((sum / rateeRatings.length).toFixed(2));
      const updatedUser = await tx.user.update({
        where: { id: rateeId },
        data: { reputationScore: newAverage, totalRatings: rateeRatings.length },
      });
      return updatedUser;
    });
    return res.status(201).json({ message: 'Rating submitted!', newReputationScore: result.reputationScore });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to submit rating.' });
  }
});

// --- SOCKET.IO GATEWAY ---
io.on('connection', (socket) => {
  socket.on('create_ride', async (rideData) => {
    try {
      const newRide = await prisma.ride.create({
        data: {
          hostUserId: rideData.hostUserId,
          origin: rideData.origin,
          destination: rideData.destination,
          departureTime: new Date(rideData.departureTime || Date.now()),
          maxSeats: parseInt(rideData.maxSeats) || 4,
          currentSeatsFilled: 1,
          type: rideData.type || 'cab_pool',
        },
        include: { host: { select: { fullName: true, branch: true } } }
      });
      io.emit('ride_broadcast', newRide);
    } catch (error) {
      socket.emit('error', { message: 'Could not create ride.' });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
