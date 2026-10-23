require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const { connectDB, pool } = require("./config/db");
const { UPLOAD_DIR } = require("./utils/storage");
const authRoutes = require("./routes/authRoutes");
const userRoutes = require("./routes/userRoutes");
const conversationRoutes = require("./routes/conversationRoutes");
const messageRoutes = require("./routes/messageRoutes");
const agoraRoutes = require("./routes/agoraRoutes");
const callRoutes = require("./routes/callRoutes");
const uploadRoutes = require("./routes/uploadRoutes");
const { errorHandler } = require("./middleware/errorMiddleware");
const { initializeSocket } = require("./sockets/socketHandler");

const app = express();

// Behind the Caddy reverse proxy in production
app.set("trust proxy", 1);

// CLIENT_URL may be a comma-separated list; the mobile app sends no Origin header and is always allowed
const corsOrigin = process.env.CLIENT_URL ? process.env.CLIENT_URL.split(",").map((o) => o.trim()) : true;

// ─── Core Middleware ──────────────────────────────────────────────────────────
app.use(
  cors({
    origin: corsOrigin,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);
app.use(express.json({ limit: "10kb" })); // Limit request body size
app.use(express.urlencoded({ extended: true }));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ─── Uploaded files (chat media, avatars, voice messages) ─────────────────────
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "30d", immutable: true, index: false }));

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/conversations", conversationRoutes);
app.use("/api/messages", messageRoutes);
// Audio/video calling is off unless CALLS_ENABLED=true
if (process.env.CALLS_ENABLED === "true") {
  app.use("/api/agora", agoraRoutes);
  app.use("/api/call", callRoutes);
}
app.use("/api/upload", uploadRoutes);

// ─── 404 Handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Route not found." });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use(errorHandler);

// ─── HTTP + Socket.io Server ──────────────────────────────────────────────────
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: corsOrigin,
    methods: ["GET", "POST"],
    credentials: true,
  },
  pingTimeout: 60000,   // How long to wait for pong before closing connection
  pingInterval: 25000,  // How often to ping the client
});

// Register all socket event handlers
initializeSocket(io);

// Store io in app to access from controllers
app.set("io", io);

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

connectDB().then(() => {
  httpServer.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT} in ${process.env.NODE_ENV || "development"} mode`);
    console.log(`📡 Socket.io ready for real-time connections`);
  });
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
process.on("SIGTERM", () => {
  console.log("SIGTERM received. Shutting down gracefully...");
  httpServer.close(async () => {
    console.log("HTTP server closed.");
    await pool.end();
    process.exit(0);
  });
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err.message);
  httpServer.close(() => process.exit(1));
});
