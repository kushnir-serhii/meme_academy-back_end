import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { GameRoomManager } from "../game";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: [
      "http://localhost:3000",
      "http://localhost:3001",
      "https://meme-academy.vercel.app",
    ],
    methods: ["GET", "POST"],
  },
});

const roomManager = new GameRoomManager(io);

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});



// Room info endpoint
app.get("/room/:code", (req, res) => {
  const info = roomManager.getRoomInfo(req.params.code);
  res.json(info);
});

// Socket.io connection handling
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on(
    "create_room",
    ({ nickname, locale, avatarId, bgColor }: { nickname: string; locale?: string; avatarId?: number | null; bgColor?: string | null }) => {
      console.log("Creating room for:", nickname, "locale:", locale);
      roomManager.createRoom(socket, nickname, locale, avatarId, bgColor);
    },
  );

  socket.on(
    "join_room",
    ({
      roomCode,
      nickname,
      locale,
      avatarId,
      bgColor,
    }: {
      roomCode: string;
      nickname: string;
      locale?: string;
      avatarId?: number | null;
      bgColor?: string | null;
    }) => {
      console.log("Joining room:", roomCode, "as", nickname, "locale:", locale);
      roomManager.joinRoom(socket, roomCode, nickname, locale, avatarId, bgColor);
    },
  );

  socket.on(
    "reconnect_room",
    ({
      playerId,
      roomCode,
      locale,
    }: {
      playerId: string;
      roomCode: string;
      locale?: string;
    }) => {
      console.log("Reconnecting:", playerId, "to", roomCode, "locale:", locale);
      roomManager.reconnect(socket, playerId, roomCode, locale);
    },
  );

  socket.on("change_locale", ({ locale }: { locale: string }) => {
    console.log("Changing locale to:", locale);
    roomManager.changeLocale(socket, locale);
  });

  socket.on("start_game", () => {
    console.log("Starting game");
    roomManager.startGame(socket);
  });

  socket.on("select_phrase", ({ phraseId }: { phraseId: string }) => {
    console.log("Selecting phrase:", phraseId);
    roomManager.selectPhrase(socket, phraseId);
  });

  socket.on("submit_meme", ({ memeId }: { memeId: string }) => {
    console.log("Submitting meme:", memeId);
    roomManager.submitMeme(socket, memeId);
  });

  socket.on("select_winner", ({ oderId }: { oderId: string }) => {
    console.log("Selecting winner:", oderId);
    roomManager.selectWinner(socket, oderId);
  });

  socket.on("next_round", () => {
    console.log("Next round");
    roomManager.nextRound(socket);
  });

  socket.on("finish_game", () => {
    console.log("Finishing game");
    roomManager.finishGame(socket);
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    roomManager.handleDisconnect(socket);
  });
});

const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, () => {
  console.log(`Game server running on port ${PORT}`);
});
