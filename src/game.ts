import { Server, Socket } from "socket.io";
import {
  GAME_SETTINGS,
  PlayerId,
  ServerPlayer,
  ServerRoom,
  ServerRoundState,
  toPublicState,
} from "./types";
import {
  GAME_CONFIG,
  generatePlayerId,
  generateRoomCode,
  getRandomAvatarColor,
} from "./constants";
import { getRandomMemes } from "./content/memes";
import { getRandomPhrases } from "./content/phrases/index";
import { Locale, getErrorMessage, normalizeLocale } from "./i18n";

export class GameRoomManager {
  private rooms: Map<string, ServerRoom> = new Map();
  private socketToPlayer: Map<string, { roomCode: string; playerId: string }> =
    new Map();
  private io: Server;

  constructor(io: Server) {
    this.io = io;
  }

  createRoom(socket: Socket, nickname: string, locale: string = "en", avatarId?: number | null, bgColor?: string | null): void {
    const roomCode = generateRoomCode();
    const playerId = generatePlayerId();
    const normalizedLocale = normalizeLocale(locale);

    const player: ServerPlayer = {
      id: playerId,
      nickname,
      avatarColor: bgColor || getRandomAvatarColor(),
      avatarId: avatarId ?? null,
      score: 0,
      isConnected: true,
      isHost: true,
      socketId: socket.id,
      hand: [],
      locale: normalizedLocale,
    };

    const room: ServerRoom = {
      code: roomCode,
      phase: "lobby",
      players: new Map([[playerId, player]]),
      hostId: playerId,
      currentRound: null,
      usedPhraseIds: [],
      usedMemeIds: [],
      createdAt: Date.now(),
    };

    this.rooms.set(roomCode, room);
    this.socketToPlayer.set(socket.id, { roomCode, playerId });

    socket.join(roomCode);

    socket.emit("room_created", { roomCode, playerId });
    socket.emit("room_state", { state: toPublicState(room) });
  }

  joinRoom(socket: Socket, roomCode: string, nickname: string, locale: string = "en", avatarId?: number | null, bgColor?: string | null): void {
    const normalizedLocale = normalizeLocale(locale);
    const room = this.rooms.get(roomCode.toUpperCase());

    if (!room) {
      socket.emit("error", { message: getErrorMessage("ROOM_NOT_FOUND", normalizedLocale) });
      return;
    }

    if (room.phase !== "lobby") {
      socket.emit("error", { message: getErrorMessage("GAME_IN_PROGRESS", normalizedLocale) });
      return;
    }

    if (room.players.size >= GAME_SETTINGS.maxPlayers) {
      socket.emit("error", { message: getErrorMessage("ROOM_FULL", normalizedLocale) });
      return;
    }

    // Check nickname uniqueness (case-insensitive)
    const nicknameTaken = Array.from(room.players.values()).some(
      p => p.nickname.toLowerCase() === nickname.toLowerCase()
    );
    if (nicknameTaken) {
      socket.emit("error", { message: getErrorMessage("NICKNAME_TAKEN", normalizedLocale) });
      return;
    }

    // Check avatar + bgColor combo uniqueness
    const resolvedAvatarId = avatarId ?? null;
    const resolvedColor = bgColor || null;
    if (resolvedAvatarId !== null && resolvedColor !== null) {
      const comboTaken = Array.from(room.players.values()).some(
        p => p.avatarId === resolvedAvatarId && p.avatarColor === resolvedColor
      );
      if (comboTaken) {
        socket.emit("error", { message: getErrorMessage("AVATAR_COMBO_TAKEN", normalizedLocale) });
        return;
      }
    }

    const playerId = generatePlayerId();

    const player: ServerPlayer = {
      id: playerId,
      nickname,
      avatarColor: bgColor || getRandomAvatarColor(),
      avatarId: resolvedAvatarId,
      score: 0,
      isConnected: true,
      isHost: false,
      socketId: socket.id,
      hand: [],
      locale: normalizedLocale,
    };

    room.players.set(playerId, player);
    this.socketToPlayer.set(socket.id, { roomCode: room.code, playerId });

    socket.join(room.code);

    socket.emit("room_joined", { playerId });

    // Broadcast to all in room
    this.io.to(room.code).emit("room_state", { state: toPublicState(room) });
    this.io.to(room.code).emit("player_joined", {
      player: {
        id: player.id,
        nickname: player.nickname,
        avatarColor: player.avatarColor,
        avatarId: player.avatarId,
        score: player.score,
        isConnected: player.isConnected,
        isHost: player.isHost,
      },
    });
  }

  reconnect(socket: Socket, playerId: string, roomCode: string, locale?: string): void {
    const normalizedLocale = normalizeLocale(locale);
    const room = this.rooms.get(roomCode.toUpperCase());

    if (!room) {
      socket.emit("error", { message: getErrorMessage("ROOM_NOT_FOUND", normalizedLocale) });
      return;
    }

    const player = room.players.get(playerId);

    if (!player) {
      socket.emit("error", { message: getErrorMessage("PLAYER_NOT_FOUND", normalizedLocale) });
      return;
    }

    // Update socket mapping and locale if provided
    player.socketId = socket.id;
    player.isConnected = true;
    if (locale) {
      player.locale = normalizedLocale;
    }
    this.socketToPlayer.set(socket.id, { roomCode: room.code, playerId });

    socket.join(room.code);

    socket.emit("room_joined", { playerId });
    socket.emit("room_state", { state: toPublicState(room) });

    // Send player's hand if game is in progress
    if (player.hand.length > 0) {
      socket.emit("hand_dealt", { hand: player.hand });
    }

    this.io.to(room.code).emit("player_reconnected", { playerId });
  }

  changeLocale(socket: Socket, locale: string): void {
    const info = this.socketToPlayer.get(socket.id);
    if (!info) return;

    const room = this.rooms.get(info.roomCode);
    if (!room) return;

    const player = room.players.get(info.playerId);
    if (!player) return;

    player.locale = normalizeLocale(locale);
    socket.emit("locale_changed", { locale: player.locale });
  }

  private getPlayerLocale(socket: Socket): Locale {
    const info = this.socketToPlayer.get(socket.id);
    if (!info) return "en";

    const room = this.rooms.get(info.roomCode);
    if (!room) return "en";

    const player = room.players.get(info.playerId);
    return player?.locale || "en";
  }

  startGame(socket: Socket): void {
    const info = this.socketToPlayer.get(socket.id);
    if (!info) return;

    const room = this.rooms.get(info.roomCode);
    if (!room) return;

    const player = room.players.get(info.playerId);
    const locale = this.getPlayerLocale(socket);

    if (!player?.isHost) {
      socket.emit("error", { message: getErrorMessage("NOT_HOST", locale) });
      return;
    }

    if (room.players.size < GAME_SETTINGS.minPlayers) {
      socket.emit("error", {
        message: getErrorMessage("NOT_ENOUGH_PLAYERS", locale),
      });
      return;
    }

    // Deal initial hands to all players
    this.dealHands(room);

    // Host (room creator) is the first judge
    const judgeId = room.hostId;

    // Start first round - judge selects phrase first
    room.currentRound = this.createRound(room, judgeId);
    room.phase = "phrase_selection";

    // Send state to all
    this.io.to(room.code).emit("room_state", { state: toPublicState(room) });

    // Send individual hands
    for (const [pid, p] of room.players) {
      const playerSocket = this.io.sockets.sockets.get(p.socketId);
      if (playerSocket) {
        playerSocket.emit("hand_dealt", { hand: p.hand });
      }
    }
  }

  selectPhrase(socket: Socket, phraseId: string): void {
    const info = this.socketToPlayer.get(socket.id);
    if (!info) return;

    const room = this.rooms.get(info.roomCode);
    if (!room || room.phase !== "phrase_selection" || !room.currentRound)
      return;

    // Only judge can select phrase
    const locale = this.getPlayerLocale(socket);
    if (info.playerId !== room.currentRound.judgeId) {
      socket.emit("error", { message: getErrorMessage("NOT_JUDGE", locale) });
      return;
    }

    // Find the phrase in options
    const selectedPhrase = room.currentRound.phraseOptions.find(
      (p) => p.id === phraseId,
    );
    if (!selectedPhrase) {
      socket.emit("error", { message: getErrorMessage("INVALID_PHRASE", locale) });
      return;
    }

    // Set the selected phrase and mark it as used
    room.currentRound.phrase = selectedPhrase;
    room.usedPhraseIds.push(selectedPhrase.id);
    room.phase = "picking";

    // Notify all players
    this.io.to(room.code).emit("phrase_selected", { phrase: selectedPhrase });
    this.io.to(room.code).emit("room_state", { state: toPublicState(room) });
  }

  submitMeme(socket: Socket, memeId: string): void {
    const info = this.socketToPlayer.get(socket.id);
    if (!info) return;

    const room = this.rooms.get(info.roomCode);
    if (!room || room.phase !== "picking") return;

    const player = room.players.get(info.playerId);
    if (!player || !room.currentRound) return;

    const locale = this.getPlayerLocale(socket);

    // Judge cannot submit
    if (info.playerId === room.currentRound.judgeId) {
      socket.emit("error", { message: getErrorMessage("JUDGE_CANNOT_SUBMIT", locale) });
      return;
    }

    // Check if already submitted
    if (room.currentRound.submissions.has(info.playerId)) {
      socket.emit("error", { message: getErrorMessage("ALREADY_SUBMITTED", locale) });
      return;
    }

    // Find meme in player's hand
    const meme = player.hand.find((m) => m.id === memeId);
    if (!meme) {
      socket.emit("error", { message: getErrorMessage("INVALID_MEME", locale) });
      return;
    }

    // Record submission
    room.currentRound.submissions.set(info.playerId, { memeId, meme });

    // Remove from hand
    player.hand = player.hand.filter((m) => m.id !== memeId);

    // Notify room
    this.io.to(room.code).emit("player_submitted", { playerId: info.playerId });

    // Check if all non-judge players submitted
    const nonJudgePlayers = Array.from(room.players.keys()).filter(
      (id) => id !== room.currentRound?.judgeId,
    );

    if (room.currentRound.submissions.size === nonJudgePlayers.length) {
      // ALL PLAYERS SUBMITTED - SHUFFLE ONCE AND STORE THE ORDER
      const submissionEntries = Array.from(
        room.currentRound.submissions.entries(),
      );
      const shuffled = submissionEntries.sort(() => Math.random() - 0.5);
      room.currentRound.shuffledSubmissionOrder = shuffled.map(
        ([playerId]) => playerId,
      );

      room.phase = "judging";
      this.io.to(room.code).emit("room_state", { state: toPublicState(room) });
    }
  }

  selectWinner(socket: Socket, oderId: string): void {
    const info = this.socketToPlayer.get(socket.id);
    if (!info) return;

    const room = this.rooms.get(info.roomCode);
    if (!room || room.phase !== "judging") return;

    const locale = this.getPlayerLocale(socket);

    if (!room.currentRound || info.playerId !== room.currentRound.judgeId) {
      socket.emit("error", { message: getErrorMessage("NOT_JUDGE", locale) });
      return;
    }

    // Parse oderId format "order-X" to get the index
    const orderIndex = parseInt(oderId.replace("order-", ""), 10);

    if (
      isNaN(orderIndex) ||
      orderIndex < 0 ||
      orderIndex >= room.currentRound.shuffledSubmissionOrder.length
    ) {
      socket.emit("error", { message: getErrorMessage("INVALID_SELECTION", locale) });
      return;
    }

    // Use the stored shuffle order to find the correct winner
    const winnerId = room.currentRound.shuffledSubmissionOrder[orderIndex];
    const winningSubmission = room.currentRound.submissions.get(winnerId);

    if (!winnerId || !winningSubmission) {
      socket.emit("error", { message: getErrorMessage("INVALID_SELECTION", locale) });
      return;
    }

    // Update score
    const winner = room.players.get(winnerId);
    if (winner) {
      winner.score += 1;
    }

    room.currentRound.winnerId = winnerId;
    room.currentRound.winningMemeId = winningSubmission.memeId;
    room.phase = "result";

    this.io.to(room.code).emit("winner_selected", { winnerId, oderId });
    this.io.to(room.code).emit("room_state", { state: toPublicState(room) });
  }

  nextRound(socket: Socket): void {
    const info = this.socketToPlayer.get(socket.id);
    if (!info) return;

    const room = this.rooms.get(info.roomCode);
    if (!room || room.phase !== "result" || !room.currentRound) return;

    const winnerId = room.currentRound.winnerId;
    if (!winnerId) return;

    // Only winner (next judge) can start next round
    if (info.playerId !== winnerId) {
      const locale = this.getPlayerLocale(socket);
      socket.emit("error", {
        message: getErrorMessage("NOT_WINNER", locale),
      });
      return;
    }

    // Replenish hands (give each player who submitted a new card)
    this.replenishHands(room);

    // Winner becomes next judge - they select phrase first
    room.currentRound = this.createRound(room, winnerId);
    room.phase = "phrase_selection";

    // Send updated state
    this.io.to(room.code).emit("room_state", { state: toPublicState(room) });
    this.io
      .to(room.code)
      .emit("new_round", { round: toPublicState(room).currentRound });

    // Send individual hands
    for (const [, p] of room.players) {
      const playerSocket = this.io.sockets.sockets.get(p.socketId);
      if (playerSocket) {
        playerSocket.emit("hand_dealt", { hand: p.hand });
      }
    }
  }

  finishGame(socket: Socket): void {
    const info = this.socketToPlayer.get(socket.id);
    if (!info) return;

    const room = this.rooms.get(info.roomCode);
    if (!room) return;

    const player = room.players.get(info.playerId);
    if (!player) return;

    // Validate: only host can finish the game
    if (room.hostId !== info.playerId) {
      const locale = player.locale as Locale;
      socket.emit("error", { message: getErrorMessage("NOT_HOST", locale) });
      return;
    }

    console.log(`Host ${info.playerId} finishing game in room ${info.roomCode}`);

    // Broadcast to all players in the room
    this.io.to(room.code).emit("game_finished");

    // Clean up socketToPlayer entries for all players
    for (const p of room.players.values()) {
      this.socketToPlayer.delete(p.socketId);
    }

    // Delete the room
    this.rooms.delete(room.code);
  }

  handleDisconnect(socket: Socket): void {
    const info = this.socketToPlayer.get(socket.id);
    if (!info) return;

    const room = this.rooms.get(info.roomCode);
    if (!room) return;

    const player = room.players.get(info.playerId);
    if (!player) return;

    player.isConnected = false;
    this.socketToPlayer.delete(socket.id);

    this.io.to(room.code).emit("player_left", { playerId: info.playerId });

    // In lobby, remove player after grace period
    if (room.phase === "lobby") {
      setTimeout(() => {
        const p = room.players.get(info.playerId);
        if (p && !p.isConnected) {
          room.players.delete(info.playerId);

          // If host left, assign new host
          if (info.playerId === room.hostId && room.players.size > 0) {
            const newHost = room.players.values().next().value;
            if (newHost) {
              newHost.isHost = true;
              room.hostId = newHost.id;
            }
          }

          // Delete room if empty
          if (room.players.size === 0) {
            this.rooms.delete(room.code);
          } else {
            this.io
              .to(room.code)
              .emit("room_state", { state: toPublicState(room) });
          }
        }
      }, GAME_CONFIG.reconnectGracePeriodMs);
    }
  }

  private dealHands(room: ServerRoom): void {
    const allUsedMemeIds: string[] = [];

    for (const [playerId, player] of room.players) {
      const hand = getRandomMemes(GAME_SETTINGS.memesPerHand, allUsedMemeIds);
      player.hand = hand;
      hand.forEach((m) => allUsedMemeIds.push(m.id));
    }

    room.usedMemeIds = allUsedMemeIds;
  }

  private replenishHands(room: ServerRoom): void {
    if (!room.currentRound) return;

    // Give each player who submitted a new card
    for (const playerId of room.currentRound.submissions.keys()) {
      const player = room.players.get(playerId);
      if (!player) continue;

      const newCard = getRandomMemes(1, room.usedMemeIds)[0];
      if (newCard) {
        player.hand.push(newCard);
        room.usedMemeIds.push(newCard.id);
      }
    }
  }

  private createRound(room: ServerRoom, judgeId: PlayerId): ServerRoundState {
    // Get phrases in judge's language
    const judge = room.players.get(judgeId);
    const judgeLocale = judge?.locale || "en";
    const phraseOptions = getRandomPhrases(3, room.usedPhraseIds, judgeLocale);

    return {
      roundNumber: (room.currentRound?.roundNumber ?? 0) + 1,
      judgeId,
      phraseOptions,
      phrase: null,
      submissions: new Map(),
      shuffledSubmissionOrder: [], // Initialize as empty array
      winnerId: null,
      winningMemeId: null,
    };
  }

  getRoomInfo(roomCode: string): {
    exists: boolean;
    playerCount?: number;
    phase?: string;
    canJoin?: boolean;
  } {
    const room = this.rooms.get(roomCode.toUpperCase());
    if (!room) {
      return { exists: false };
    }
    return {
      exists: true,
      playerCount: room.players.size,
      phase: room.phase,
      canJoin:
        room.phase === "lobby" && room.players.size < GAME_SETTINGS.maxPlayers,
    };
  }
}
