const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
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

// --- REST API ENDPOINTS ---

// Health Check route for Render
app.get('/', (req, res) => {
  res.status(200).json({ status: 'DTU Route & Cart Backend is running successfully!' });
});

// Fetch active open rides
app.get('/api/rides/active', async (req, res) => {
  try {
    const rides = await prisma.ride.findMany({
      where: { status: 'open' },
      include: {
        host: { select: { fullName: true, branch: true, reputationScore: true } }
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.status(200).json(rides);
  } catch (error) {
    console.error('[Fetch Rides Error]:', error);
    return res.status(500).json({ error: 'Failed to fetch active rides.' });
  }
});

// Submit Peer Rating & Recalculate Reputation Score
app.post('/api/ratings', async (req, res) => {
  const { rideId, deliveryId, raterId, rateeId, score, comment } = req.body;

  if (!score || score < 1 || score > 5) {
    return res.status(400).json({ error: 'Score must be an integer between 1 and 5.' });
  }

  if (raterId === rateeId) {
    return res.status(400).json({ error: 'Users cannot rate themselves.' });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const newRating = await tx.rating.create({
        data: { rideId: rideId || null, deliveryId: deliveryId || null, raterId, rateeId, score, comment },
      });

      const rateeRatings = await tx.rating.findMany({
        where: { rateeId },
        select: { score: true },
      });

      const totalRatings = rateeRatings.length;
      const sumScores = rateeRatings.reduce((acc, curr) => acc + curr.score, 0);
      const newAverage = Number((sumScores / totalRatings).toFixed(2));

      const updatedUser = await tx.user.update({
        where: { id: rateeId },
        data: { reputationScore: newAverage, totalRatings: totalRatings },
      });

      return { newRating, updatedUser };
    });

    return res.status(201).json({
      message: 'Rating submitted successfully!',
      newReputationScore: result.updatedUser.reputationScore,
    });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'You have already rated this user for this trip.' });
    }
    console.error('[Rating Error]:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// --- SOCKET.IO REAL-TIME GATEWAY ---

io.on('connection', (socket) => {
  console.log(`[Socket Connected]: ${socket.id}`);

  socket.on('create_ride', async (rideData) => {
    try {
      const newRide = await prisma.ride.create({
        data: {
          hostUserId: rideData.hostUserId || 'default-user-uuid',
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
      console.error('[Socket Error - Create Ride]:', error);
      socket.emit('error', { message: 'Could not save ride to database.' });
    }
  });

  socket.on('join_ride', async ({ rideId, userId }) => {
    try {
      const updatedRide = await prisma.$transaction(async (tx) => {
        const ride = await tx.ride.findUnique({ where: { id: rideId } });
        if (!ride) throw new Error('Ride not found.');
        if (ride.status !== 'open') throw new Error('Ride is no longer accepting passengers.');
        if (ride.currentSeatsFilled >= ride.maxSeats) throw new Error('Ride is full.');

        await tx.rideParticipant.create({ data: { rideId, userId } });

        return await tx.ride.update({
          where: { id: rideId },
          data: {
            currentSeatsFilled: { increment: 1 },
            status: (ride.currentSeatsFilled + 1 >= ride.maxSeats) ? 'matched' : 'open'
          }
        });
      });

      io.emit('ride_updated', {
        rideId: updatedRide.id,
        currentSeatsFilled: updatedRide.currentSeatsFilled,
        status: updatedRide.status,
      });
      socket.emit('join_success', { message: 'Successfully joined ride pool!' });
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('disconnect', () => {
    console.log(`[Socket Disconnected]: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`DTU Gateway Backend running on port ${PORT}`);
});