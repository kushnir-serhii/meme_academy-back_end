# Meme Academy Server - Context for Separate Repository

Copy this to `CLAUDE.md` in your server repository.

---

# Meme Academy Server

## Overview
Socket.io game server for the Meme Academy multiplayer party game. Handles room management, game state, and real-time communication.

## Tech Stack
- Node.js, Express, Socket.io, TypeScript

## Project Structure

```
src/
├── index.ts        # Express + Socket.io setup, event handlers
├── GameRoom.ts     # GameRoomManager class (all game logic)
├── types.ts        # Server-side types
└── content/        # Meme and phrase data pools (if not fetched from API)
```

## Game Flow & Phases

```
lobby → phrase_selection → picking → judging → result → phrase_selection → ...
```

| Phase | Who acts | Next phase trigger |
|-------|----------|-------------------|
| `lobby` | Host clicks start | `start_game` event → random player becomes judge |
| `phrase_selection` | Judge picks phrase (3-slide carousel UI) | `select_phrase` event |
| `picking` | All non-judges submit | All players submitted |
| `judging` | Judge picks winner | `select_winner` event |
| `result` | Winner clicks "Next Round" | `next_round` event → winner becomes next judge |

**Critical**:
- First judge is randomly selected when game starts
- Winner becomes the next judge (not the current judge)

## Socket Events

### Client → Server
```typescript
socket.on('create_room', ({ nickname }) => ...)
socket.on('join_room', ({ roomCode, nickname }) => ...)
socket.on('reconnect_room', ({ playerId, roomCode }) => ...)
socket.on('start_game', () => ...)
socket.on('select_phrase', ({ phraseId }) => ...)
socket.on('submit_meme', ({ memeId }) => ...)
socket.on('select_winner', ({ oderId }) => ...)
socket.on('next_round', () => ...)
socket.on('finish_game', () => ...)   // Host only — ends the game, broadcasts game_finished to all players
```

### Server → Client
```typescript
socket.emit('room_created', { roomCode, playerId })
socket.emit('room_joined', { playerId })
socket.emit('room_state', { state: GameState })
socket.emit('hand_dealt', { hand: MemeCard[] })
socket.emit('player_joined', { player })
socket.emit('player_left', { playerId })
socket.emit('player_reconnected', { playerId })
socket.emit('phrase_selected', { phrase })
socket.emit('player_submitted', { playerId })
socket.emit('winner_selected', { winnerId, oderId })
socket.emit('new_round', { round })
socket.emit('game_finished')          // Broadcast to all — triggers /finished page redirect on all clients
socket.emit('error', { message })
```

## Types

```typescript
type GamePhase = 'lobby' | 'phrase_selection' | 'picking' | 'judging' | 'result';
type PlayerId = string;  // UUID
type RoomCode = string;  // 6 char alphanumeric

interface Player {
  id: PlayerId;
  nickname: string;
  avatarColor: string;
  score: number;
  isConnected: boolean;
  isHost: boolean;
}

interface ServerPlayer extends Player {
  socketId: string;
  hand: MemeCard[];
}

interface MemeCard {
  id: string;
  imageUrl: string;
}

interface Phrase {
  id: string;
  text: string;
}

interface ServerRoundState {
  roundNumber: number;
  judgeId: PlayerId;
  phraseOptions: Phrase[];           // 3 options for judge
  phrase: Phrase | null;             // null until judge selects
  submissions: Map<PlayerId, { memeId: string; meme: MemeCard }>;
  winnerId: PlayerId | null;
  winningMemeId: string | null;
}

interface ServerRoom {
  code: RoomCode;
  phase: GamePhase;
  players: Map<PlayerId, ServerPlayer>;
  hostId: PlayerId;
  currentRound: ServerRoundState | null;
  usedPhraseIds: string[];
  usedMemeIds: string[];
  createdAt: number;
}
```

## GameRoomManager Methods

```typescript
class GameRoomManager {
  // Room lifecycle
  createRoom(socket, nickname): void    // Creates room, player becomes host
  joinRoom(socket, roomCode, nickname): void
  reconnect(socket, playerId, roomCode): void
  handleDisconnect(socket): void        // Marks player disconnected, cleanup

  // Game actions (all validate caller + phase)
  startGame(socket): void               // Host only, phase: lobby
  selectPhrase(socket, phraseId): void  // Judge only, phase: phrase_selection
  submitMeme(socket, memeId): void      // Non-judge, phase: picking
  selectWinner(socket, oderId): void    // Judge only, phase: judging
  nextRound(socket): void               // Winner only, phase: result
  finishGame(socket): void              // Host only — broadcasts game_finished, cleans up room

  // Internal helpers
  private dealHands(room): void         // Give each player 10 memes
  private replenishHands(room): void    // Give 1 new meme to each who submitted
  private createRound(room, judgeId): ServerRoundState
}
```

## Key Logic Details

### Room Creation
- Generate 6-char room code
- First player is host
- Store socket → player mapping

### Start Game
- Validate: host only, min 3 players
- Deal hands (10 memes each, no duplicates)
- **Pick random first judge** (any player, including host)
- Create round with 3 phrase options (`phraseOptions`)
- **Phase → `phrase_selection`** (NOT `picking`!)
- Judge sees carousel, other players see waiting screen

### Phrase Selection
- Judge picks from `phraseOptions`
- Set `phrase`, mark as used
- Phase → `picking`

### Meme Submission
- Remove meme from player's hand
- Track in `submissions` Map
- When all non-judges submit → phase `judging`

### Winner Selection
- `oderId` format: `"order-X"` (shuffled index)
- Find actual player from submissions
- Award point to winner
- Phase → `result`

### Next Round
- Only **winner** can trigger (they become next judge)
- Replenish hands (1 card each)
- Create new round with 3 fresh phrases
- Phase → `phrase_selection`

## Public State Transformation

`toPublicState(room)` converts ServerRoom to client-safe state:
- Strips `socketId` and `hand` from players
- **Must include `phraseOptions`** in `currentRound` for phrase selection UI
- Only reveals submissions during `judging`/`result` phases
- Uses stored `shuffledSubmissionOrder` (do NOT shuffle on every call!)

## CRITICAL BUG FIX: Submission Shuffle Order

**Problem**: If you shuffle submissions in `toPublicState()` every time it's called, the `oderId` ("order-0", "order-1") will map to different players each time. When judge selects "order-0", a NEW shuffle happens and the wrong player wins!

**Fix**: Store shuffle order once when entering `judging` phase.

### 1. Update ServerRoundState type:
```typescript
interface ServerRoundState {
  roundNumber: number;
  judgeId: PlayerId;
  phraseOptions: Phrase[];
  phrase: Phrase | null;
  submissions: Map<PlayerId, { memeId: string; meme: MemeCard }>;
  shuffledSubmissionOrder: PlayerId[];  // ADD THIS - stores the shuffle order
  winnerId: PlayerId | null;
  winningMemeId: string | null;
}
```

### 2. Update submitMeme() - shuffle once when all submit:
```typescript
// When all non-judges submit, shuffle and store the order
if (room.currentRound.submissions.size === nonJudgePlayers.length) {
  // Shuffle ONCE and store the order
  const playerIds = Array.from(room.currentRound.submissions.keys());
  room.currentRound.shuffledSubmissionOrder = playerIds.sort(() => Math.random() - 0.5);

  room.phase = 'judging';
  this.io.to(room.code).emit('room_state', { state: toPublicState(room) });
}
```

### 3. Update toPublicState() - use stored order:
```typescript
// Only reveal submissions during judging or result phase
let revealedSubmissions: Submission[] = [];
if (room.phase === 'judging' || room.phase === 'result') {
  // Use the STORED shuffle order, don't re-shuffle!
  const order = room.currentRound.shuffledSubmissionOrder || [];

  revealedSubmissions = order.map((playerId, index) => {
    const sub = room.currentRound!.submissions.get(playerId)!;
    return {
      oderId: `order-${index}`,
      memeId: sub.memeId,
      meme: sub.meme,
    };
  });
}
```

### 4. Update selectWinner() - find by memeId directly:
```typescript
selectWinner(socket: Socket, oderId: string): void {
  // ... validation ...

  // Get the index from oderId
  const index = parseInt(oderId.replace('order-', ''), 10);
  const shuffledOrder = room.currentRound.shuffledSubmissionOrder;

  if (index < 0 || index >= shuffledOrder.length) {
    socket.emit('error', { message: 'Invalid selection' });
    return;
  }

  // Get the actual player ID from stored shuffle order
  const winnerId = shuffledOrder[index];
  const winningSubmission = room.currentRound.submissions.get(winnerId);

  if (!winnerId || !winningSubmission) {
    socket.emit('error', { message: 'Invalid selection' });
    return;
  }

  // Award point
  const winner = room.players.get(winnerId);
  if (winner) {
    winner.score += 1;
  }

  room.currentRound.winnerId = winnerId;
  room.currentRound.winningMemeId = winningSubmission.memeId;
  room.phase = 'result';

  this.io.to(room.code).emit('winner_selected', { winnerId, oderId });
  this.io.to(room.code).emit('room_state', { state: toPublicState(room) });
}
```

### 5. Update createRound() - initialize empty array:
```typescript
private createRound(room: ServerRoom, judgeId: PlayerId): ServerRoundState {
  const phraseOptions = getRandomPhrases(3, room.usedPhraseIds);

  return {
    roundNumber: (room.currentRound?.roundNumber ?? 0) + 1,
    judgeId,
    phraseOptions,
    phrase: null,
    submissions: new Map(),
    shuffledSubmissionOrder: [],  // ADD THIS
    winnerId: null,
    winningMemeId: null,
  };
}
```

## CORS Config
```typescript
const io = new Server(httpServer, {
  cors: {
    origin: ['http://localhost:3000', 'your-production-url'],
    methods: ['GET', 'POST'],
  },
});
```

## Environment
```env
PORT=3001
```

---

# Multilanguage (i18n) Implementation

The game supports multiple languages: English (en), Ukrainian (uk), Polish (pl).

## Overview

- **Frontend** sends `locale` with socket events
- **Server** stores locale per player
- **Server** translates error messages and phrases before sending to client
- Phrases are stored per locale on the server

## Project Structure Changes

```
src/
├── index.ts
├── GameRoom.ts
├── types.ts
├── locales/                 # ADD: Translation files
│   ├── en.json              # English translations
│   ├── uk.json              # Ukrainian translations
│   └── pl.json              # Polish translations
├── content/
│   ├── phrases/             # ADD: Phrases per locale
│   │   ├── en.ts            # English phrases (100+)
│   │   ├── uk.ts            # Ukrainian phrases (100+)
│   │   └── pl.ts            # Polish phrases (100+)
│   │   └── index.ts         # Export all phrase pools
│   └── memes.ts             # Meme URLs (language-independent)
└── i18n/                    # ADD: i18n utilities
    └── index.ts             # Translation helper function
```

## Type Changes

### Add Locale type
```typescript
type Locale = 'en' | 'uk' | 'pl';
const DEFAULT_LOCALE: Locale = 'en';
const SUPPORTED_LOCALES: Locale[] = ['en', 'uk', 'pl'];
```

### Update Player interface
```typescript
interface Player {
  id: PlayerId;
  nickname: string;
  avatarColor: string;
  score: number;
  isConnected: boolean;
  isHost: boolean;
  locale: Locale;  // ADD THIS
}

interface ServerPlayer extends Player {
  socketId: string;
  hand: MemeCard[];
  locale: Locale;  // ADD THIS
}
```

### Update Phrase interface
```typescript
interface Phrase {
  id: string;
  text: string;
  locale: Locale;  // ADD THIS - track which locale this phrase is in
}
```

## Socket Event Changes

### Client → Server (updated payloads)

```typescript
// ADD locale to these events:
socket.on('create_room', ({ nickname, locale }) => ...)
socket.on('join_room', ({ roomCode, nickname, locale }) => ...)
socket.on('reconnect_room', ({ playerId, roomCode, locale }) => ...)

// Optional: Allow locale change mid-game
socket.on('change_locale', ({ locale }) => ...)
```

### Server → Client (no changes to event names)

Error messages and phrases are now translated before sending.

## Translation Files

### `src/locales/en.json`
```json
{
  "errors": {
    "ROOM_NOT_FOUND": "Room not found",
    "ROOM_FULL": "Room is full (max 10 players)",
    "GAME_IN_PROGRESS": "Game has already started",
    "INVALID_NICKNAME": "Nickname must be 2-20 characters",
    "NICKNAME_TAKEN": "This nickname is already taken",
    "NOT_HOST": "Only the host can start the game",
    "NOT_ENOUGH_PLAYERS": "Need at least 3 players to start",
    "NOT_JUDGE": "Only the judge can do this",
    "NOT_YOUR_TURN": "It's not your turn",
    "NOT_WINNER": "Only the winner can start next round",
    "INVALID_PHRASE": "Invalid phrase selection",
    "INVALID_MEME": "Invalid meme selection",
    "ALREADY_SUBMITTED": "You already submitted a meme",
    "INVALID_SELECTION": "Invalid selection",
    "CONNECTION_ERROR": "Connection error occurred",
    "RECONNECT_FAILED": "Could not reconnect to room"
  }
}
```

### `src/locales/uk.json`
```json
{
  "errors": {
    "ROOM_NOT_FOUND": "Кімнату не знайдено",
    "ROOM_FULL": "Кімната заповнена (максимум 10 гравців)",
    "GAME_IN_PROGRESS": "Гра вже розпочалась",
    "INVALID_NICKNAME": "Нікнейм має бути від 2 до 20 символів",
    "NICKNAME_TAKEN": "Цей нікнейм вже зайнятий",
    "NOT_HOST": "Тільки хост може розпочати гру",
    "NOT_ENOUGH_PLAYERS": "Потрібно мінімум 3 гравці для початку",
    "NOT_JUDGE": "Тільки суддя може це зробити",
    "NOT_YOUR_TURN": "Зараз не ваша черга",
    "NOT_WINNER": "Тільки переможець може почати наступний раунд",
    "INVALID_PHRASE": "Невірний вибір фрази",
    "INVALID_MEME": "Невірний вибір мема",
    "ALREADY_SUBMITTED": "Ви вже відправили мем",
    "INVALID_SELECTION": "Невірний вибір",
    "CONNECTION_ERROR": "Помилка з'єднання",
    "RECONNECT_FAILED": "Не вдалося перепідключитися до кімнати"
  }
}
```

### `src/locales/pl.json`
```json
{
  "errors": {
    "ROOM_NOT_FOUND": "Nie znaleziono pokoju",
    "ROOM_FULL": "Pokój jest pełny (maksymalnie 10 graczy)",
    "GAME_IN_PROGRESS": "Gra już się rozpoczęła",
    "INVALID_NICKNAME": "Nick musi mieć od 2 do 20 znaków",
    "NICKNAME_TAKEN": "Ten nick jest już zajęty",
    "NOT_HOST": "Tylko host może rozpocząć grę",
    "NOT_ENOUGH_PLAYERS": "Potrzeba minimum 3 graczy do rozpoczęcia",
    "NOT_JUDGE": "Tylko sędzia może to zrobić",
    "NOT_YOUR_TURN": "To nie twoja kolej",
    "NOT_WINNER": "Tylko zwycięzca może rozpocząć następną rundę",
    "INVALID_PHRASE": "Nieprawidłowy wybór frazy",
    "INVALID_MEME": "Nieprawidłowy wybór mema",
    "ALREADY_SUBMITTED": "Już wysłałeś mema",
    "INVALID_SELECTION": "Nieprawidłowy wybór",
    "CONNECTION_ERROR": "Wystąpił błąd połączenia",
    "RECONNECT_FAILED": "Nie udało się ponownie połączyć z pokojem"
  }
}
```

## i18n Helper

### `src/i18n/index.ts`
```typescript
import en from '../locales/en.json';
import uk from '../locales/uk.json';
import pl from '../locales/pl.json';

type Locale = 'en' | 'uk' | 'pl';

const locales: Record<Locale, typeof en> = { en, uk, pl };

/**
 * Get translated error message
 * @param errorCode - Error code key (e.g., 'ROOM_NOT_FOUND')
 * @param locale - Target locale
 * @returns Translated error message (falls back to English)
 */
export function getErrorMessage(errorCode: string, locale: Locale = 'en'): string {
  const translations = locales[locale] || locales.en;
  return translations.errors[errorCode] || locales.en.errors[errorCode] || errorCode;
}

/**
 * Validate and normalize locale
 */
export function normalizeLocale(locale: string | undefined): Locale {
  if (locale && ['en', 'uk', 'pl'].includes(locale)) {
    return locale as Locale;
  }
  return 'en';
}
```

## Phrase Pools per Locale

### `src/content/phrases/en.ts`
```typescript
import { Phrase } from '../../types';

export const PHRASE_POOL_EN: Phrase[] = [
  { id: 'en-1', text: 'When you realize it\'s Monday tomorrow', locale: 'en' },
  { id: 'en-2', text: 'Me trying to adult', locale: 'en' },
  { id: 'en-3', text: 'When the WiFi goes down', locale: 'en' },
  // ... 100+ phrases
];
```

### `src/content/phrases/uk.ts`
```typescript
import { Phrase } from '../../types';

export const PHRASE_POOL_UK: Phrase[] = [
  { id: 'uk-1', text: 'Коли розумієш, що завтра понеділок', locale: 'uk' },
  { id: 'uk-2', text: 'Я намагаюсь бути дорослим', locale: 'uk' },
  { id: 'uk-3', text: 'Коли зникає WiFi', locale: 'uk' },
  // ... 100+ phrases
];
```

### `src/content/phrases/pl.ts`
```typescript
import { Phrase } from '../../types';

export const PHRASE_POOL_PL: Phrase[] = [
  { id: 'pl-1', text: 'Kiedy zdajesz sobie sprawę, że jutro poniedziałek', locale: 'pl' },
  { id: 'pl-2', text: 'Ja próbując być dorosłym', locale: 'pl' },
  { id: 'pl-3', text: 'Kiedy WiFi przestaje działać', locale: 'pl' },
  // ... 100+ phrases
];
```

### `src/content/phrases/index.ts`
```typescript
import { Phrase } from '../../types';
import { PHRASE_POOL_EN } from './en';
import { PHRASE_POOL_UK } from './uk';
import { PHRASE_POOL_PL } from './pl';

type Locale = 'en' | 'uk' | 'pl';

const PHRASE_POOLS: Record<Locale, Phrase[]> = {
  en: PHRASE_POOL_EN,
  uk: PHRASE_POOL_UK,
  pl: PHRASE_POOL_PL,
};

/**
 * Get random phrases for a specific locale
 */
export function getRandomPhrases(
  count: number,
  usedIds: string[],
  locale: Locale = 'en'
): Phrase[] {
  const pool = PHRASE_POOLS[locale] || PHRASE_POOLS.en;
  const available = pool.filter(p => !usedIds.includes(p.id));

  // Shuffle and take count
  const shuffled = [...available].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}
```

## GameRoomManager Changes

### Update `createRoom()`
```typescript
createRoom(socket: Socket, nickname: string, locale: string = 'en'): void {
  const normalizedLocale = normalizeLocale(locale);

  const player: ServerPlayer = {
    id: generatePlayerId(),
    nickname,
    avatarColor: getRandomColor(),
    score: 0,
    isConnected: true,
    isHost: true,
    locale: normalizedLocale,  // Store locale
    socketId: socket.id,
    hand: [],
  };

  // ... rest of creation logic
}
```

### Update `joinRoom()`
```typescript
joinRoom(socket: Socket, roomCode: string, nickname: string, locale: string = 'en'): void {
  const normalizedLocale = normalizeLocale(locale);
  const room = this.rooms.get(roomCode.toUpperCase());

  if (!room) {
    socket.emit('error', { message: getErrorMessage('ROOM_NOT_FOUND', normalizedLocale) });
    return;
  }

  if (room.players.size >= 10) {
    socket.emit('error', { message: getErrorMessage('ROOM_FULL', normalizedLocale) });
    return;
  }

  if (room.phase !== 'lobby') {
    socket.emit('error', { message: getErrorMessage('GAME_IN_PROGRESS', normalizedLocale) });
    return;
  }

  const player: ServerPlayer = {
    // ...
    locale: normalizedLocale,
  };

  // ... rest of join logic
}
```

### Update `reconnect()`
```typescript
reconnect(socket: Socket, playerId: string, roomCode: string, locale?: string): void {
  // ... find room and player

  if (locale) {
    player.locale = normalizeLocale(locale);
  }

  // ... rest of reconnect logic
}
```

### Update `createRound()` - Use judge's locale for phrases
```typescript
private createRound(room: ServerRoom, judgeId: PlayerId): ServerRoundState {
  const judge = room.players.get(judgeId);
  const judgeLocale = judge?.locale || 'en';

  // Get phrases in judge's language
  const phraseOptions = getRandomPhrases(3, room.usedPhraseIds, judgeLocale);

  // Mark phrase IDs as used
  phraseOptions.forEach(p => room.usedPhraseIds.push(p.id));

  return {
    roundNumber: (room.currentRound?.roundNumber ?? 0) + 1,
    judgeId,
    phraseOptions,
    phrase: null,
    submissions: new Map(),
    shuffledSubmissionOrder: [],
    winnerId: null,
    winningMemeId: null,
  };
}
```

### Update all error emissions
```typescript
// BEFORE:
socket.emit('error', { message: 'Only the host can start the game' });

// AFTER:
const player = this.getPlayerBySocket(socket);
const locale = player?.locale || 'en';
socket.emit('error', { message: getErrorMessage('NOT_HOST', locale) });
```

### Add `changeLocale()` handler (optional)
```typescript
changeLocale(socket: Socket, locale: string): void {
  const player = this.getPlayerBySocket(socket);
  if (player) {
    player.locale = normalizeLocale(locale);
    socket.emit('locale_changed', { locale: player.locale });
  }
}
```

## Complete Error Code Reference

| Error Code | When Used |
|------------|-----------|
| `ROOM_NOT_FOUND` | Room code doesn't exist |
| `ROOM_FULL` | Room has 10 players |
| `GAME_IN_PROGRESS` | Trying to join after game started |
| `INVALID_NICKNAME` | Nickname < 2 or > 20 chars |
| `NICKNAME_TAKEN` | Nickname already in use in room |
| `NOT_HOST` | Non-host tries to start game |
| `NOT_ENOUGH_PLAYERS` | Host tries to start with < 3 players |
| `NOT_JUDGE` | Non-judge tries to select phrase/winner |
| `NOT_YOUR_TURN` | Action in wrong phase |
| `NOT_WINNER` | Non-winner tries to start next round |
| `INVALID_PHRASE` | Invalid phraseId in select_phrase |
| `INVALID_MEME` | Meme not in player's hand |
| `ALREADY_SUBMITTED` | Player already submitted this round |
| `INVALID_SELECTION` | Invalid oderId in select_winner |
| `CONNECTION_ERROR` | Generic connection issue |
| `RECONNECT_FAILED` | Player/room not found on reconnect |

## Socket Event Handler Updates

### Updated event signatures
```typescript
// index.ts socket handlers

io.on('connection', (socket) => {

  socket.on('create_room', ({ nickname, locale }) => {
    gameManager.createRoom(socket, nickname, locale);
  });

  socket.on('join_room', ({ roomCode, nickname, locale }) => {
    gameManager.joinRoom(socket, roomCode, nickname, locale);
  });

  socket.on('reconnect_room', ({ playerId, roomCode, locale }) => {
    gameManager.reconnect(socket, playerId, roomCode, locale);
  });

  socket.on('change_locale', ({ locale }) => {
    gameManager.changeLocale(socket, locale);
  });

  // ... other handlers unchanged
});
```

## Testing Checklist

- [ ] Create room with each locale (en, uk, pl)
- [ ] Join room with different locale than host
- [ ] Verify error messages appear in correct language
- [ ] Verify judge sees phrases in their language
- [ ] Test locale change mid-game
- [ ] Test reconnection preserves/updates locale
- [ ] Test fallback to English for invalid locale
