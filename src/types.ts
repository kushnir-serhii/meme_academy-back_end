import { Locale } from "./i18n";

// ============ ROOM & PLAYER TYPES ============

export type RoomCode = string; // 6 character alphanumeric

export type PlayerId = string; // UUID

export interface Player {
  id: PlayerId;
  nickname: string;
  avatarColor: string;     // Hex color — client's bgColor, or random if not provided
  avatarId: number | null;
  score: number;
  isConnected: boolean;
  isHost: boolean;
  locale: Locale;
}

export interface ServerPlayer extends Player {
  socketId: string;
  hand: MemeCard[];
}

// ============ GAME STATE TYPES ============

export type GamePhase =
  | "lobby"
  | "phrase_selection"
  | "picking"
  | "judging"
  | "result";

export interface MemeCard {
  id: string;
  imageUrl: string;
}

export interface Phrase {
  id: string;
  text: string;
}

export interface Submission {
  oderId: string; // "order-0", "order-1", ... (shuffled index, fixed once at judging start)
  memeId: string;
  meme: MemeCard;
}

export interface ServerRoundState {
  roundNumber: number;
  judgeId: PlayerId;
  phraseOptions: Phrase[];
  phrase: Phrase | null;                 // null until judge selects
  submissions: Map<PlayerId, { memeId: string; meme: MemeCard }>;
  shuffledSubmissionOrder: PlayerId[];   // Shuffled once when entering judging phase — never re-shuffle
  winnerId: PlayerId | null;
  winningMemeId: string | null;
}

export interface ServerRoom {
  code: RoomCode;
  phase: GamePhase;
  players: Map<PlayerId, ServerPlayer>;
  hostId: PlayerId;
  currentRound: ServerRoundState | null;
  usedPhraseIds: string[];
  usedMemeIds: string[];
  createdAt: number;
}

// Public state sent to clients via room_state event
export interface RoomPublicState {
  roomCode: RoomCode;
  phase: GamePhase;
  players: Player[];
  hostId: PlayerId;
  currentRound: {
    roundNumber: number;
    judgeId: PlayerId;
    phraseOptions: Phrase[];           // 3 options visible during phrase_selection
    phrase: Phrase | null;             // null until judge selects
    submittedPlayerIds: PlayerId[];
    revealedSubmissions: Submission[]; // only populated during judging/result
    winnerId: PlayerId | null;
    winningMemeId: string | null;
  } | null;
}

export function toPublicState(room: ServerRoom): RoomPublicState {
  const players: Player[] = Array.from(room.players.values()).map((p) => ({
    id: p.id,
    nickname: p.nickname,
    avatarColor: p.avatarColor,
    avatarId: p.avatarId,
    score: p.score,
    isConnected: p.isConnected,
    isHost: p.isHost,
    locale: p.locale,
  }));

  let currentRound = null;
  if (room.currentRound) {
    const submittedPlayerIds = Array.from(room.currentRound.submissions.keys());

    let revealedSubmissions: Submission[] = [];
    if (room.phase === "judging" || room.phase === "result") {
      // Use stored shuffle order — never re-shuffle to keep oderId → playerId mapping stable
      revealedSubmissions = room.currentRound.shuffledSubmissionOrder.map(
        (playerId, index) => {
          const sub = room.currentRound!.submissions.get(playerId)!;
          return {
            oderId: `order-${index}`,
            memeId: sub.memeId,
            meme: sub.meme,
          };
        },
      );
    }

    currentRound = {
      roundNumber: room.currentRound.roundNumber,
      judgeId: room.currentRound.judgeId,
      phraseOptions: room.currentRound.phraseOptions,
      phrase: room.currentRound.phrase,
      submittedPlayerIds,
      revealedSubmissions,
      winnerId: room.currentRound.winnerId,
      winningMemeId: room.currentRound.winningMemeId,
    };
  }

  return {
    roomCode: room.code,
    phase: room.phase,
    players,
    hostId: room.hostId,
    currentRound,
  };
}

// ============ GAME SETTINGS ============

export const GAME_SETTINGS = {
  minPlayers: 3,
  maxPlayers: 10,
  memesPerHand: 10,
} as const;

// ============ SOCKET MESSAGE TYPES ============

// Client -> Server
export type ClientMessage =
  | { type: "create_room"; nickname: string; locale?: string; avatarId?: number | null; bgColor?: string | null }
  | { type: "join_room"; roomCode: RoomCode; nickname: string; locale?: string; avatarId?: number | null; bgColor?: string | null }
  | { type: "reconnect_room"; playerId: PlayerId; roomCode: RoomCode; locale?: string }
  | { type: "change_locale"; locale: string }
  | { type: "start_game" }
  | { type: "select_phrase"; phraseId: string }
  | { type: "submit_meme"; memeId: string }
  | { type: "select_winner"; oderId: string }
  | { type: "next_round" }
  | { type: "finish_game" };

// Server -> Client
export type ServerMessage =
  | { type: "room_created"; roomCode: RoomCode; playerId: PlayerId }
  | { type: "room_joined"; playerId: PlayerId }
  | { type: "room_state"; state: RoomPublicState }
  | { type: "hand_dealt"; hand: MemeCard[] }
  | { type: "player_joined"; player: Player }
  | { type: "player_left"; playerId: PlayerId }
  | { type: "player_reconnected"; playerId: PlayerId }
  | { type: "phrase_selected"; phrase: Phrase }
  | { type: "player_submitted"; playerId: PlayerId }
  | { type: "winner_selected"; winnerId: PlayerId; oderId: string }
  | { type: "new_round"; round: RoomPublicState["currentRound"] }
  | { type: "game_finished" }
  | { type: "locale_changed"; locale: string }
  | { type: "error"; message: string };
