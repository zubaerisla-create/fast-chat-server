/**
 * Hangman for two players (server copy of game/mini/hangman/rules.ts). Players take turns:
 * the setter submits a secret word (and optional hint), the other player guesses letters.
 * The secret word never leaves the server for the guesser until the round is over — see view().
 */
const MAX_WRONG = 6;
const ROUNDS = 4; // each player sets twice
const LETTER_RE = /^[a-z]$/;

/** Normalises and validates a submitted word: 3–16 letters a–z, at least 2 different letters. */
function normalizeWord(raw) {
  if (typeof raw !== "string") return { error: "invalid_word" };
  const word = raw.trim().toLowerCase();
  if (!/^[a-z]{3,16}$/.test(word)) return { error: "invalid_word" };
  if (new Set(word).size < 2) return { error: "invalid_word" };
  return { word };
}

function normalizeHint(raw) {
  if (raw == null || raw === "") return "";
  if (typeof raw !== "string") return null;
  const hint = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return hint.length <= 60 ? hint : null;
}

const create = (options = {}) => ({
  round: 1,
  rounds: ROUNDS,
  setter: 0,
  phase: "setting", // setting → guessing → (next round) setting … → over
  word: null,
  hint: "",
  guessed: [],
  wrong: 0,
  maxWrong: MAX_WRONG,
  score: [0, 0],
  turn: 0, // whoever must act: setter while setting, guesser while guessing
  winner: null,
  lastRound: null,
  moves: 0,
});

const mask = (word, guessed) => word.split("").map((ch) => (guessed.includes(ch) ? ch : "_")).join("");

function endRound(state, solved) {
  const guesser = 1 - state.setter;
  state.score[solved ? guesser : state.setter] += 1;
  state.lastRound = { round: state.round, word: state.word, hint: state.hint, solved, setter: state.setter, wrong: state.wrong };
  if (state.round >= state.rounds) {
    state.phase = "over";
    state.winner = state.score[0] === state.score[1] ? "draw" : state.score[0] > state.score[1] ? 0 : 1;
    return;
  }
  state.round += 1;
  state.setter = 1 - state.setter;
  state.turn = state.setter;
  state.phase = "setting";
  state.word = null;
  state.hint = "";
  state.guessed = [];
  state.wrong = 0;
}

function applyMove(state, player, move) {
  if (state.winner !== null) return "game_over";
  if (player !== state.turn) return "not_your_turn";
  if (!move || typeof move !== "object") return "invalid_move";
  if (state.phase === "setting") {
    if (move.type !== "setWord") return "invalid_move";
    const { word, error } = normalizeWord(move.word);
    if (error) return error;
    const hint = normalizeHint(move.hint);
    if (hint === null) return "invalid_hint";
    state.word = word;
    state.hint = hint;
    state.guessed = [];
    state.wrong = 0;
    state.phase = "guessing";
    state.turn = 1 - state.setter;
    state.moves += 1;
    return null;
  }
  if (state.phase === "guessing") {
    if (move.type !== "guess") return "invalid_move";
    const letter = typeof move.letter === "string" ? move.letter.toLowerCase() : "";
    if (!LETTER_RE.test(letter)) return "invalid_move";
    if (state.guessed.includes(letter)) return "already_guessed";
    state.guessed.push(letter);
    state.moves += 1;
    if (!state.word.includes(letter)) state.wrong += 1;
    if (!mask(state.word, state.guessed).includes("_")) endRound(state, true);
    else if (state.wrong >= state.maxWrong) endRound(state, false);
    return null;
  }
  return "invalid_move";
}

/** What `player` may see. The guesser gets only the masked word, never the secret. */
function view(state, player) {
  const { word, ...rest } = state;
  const out = { ...rest, guessed: state.guessed.slice(), score: state.score.slice() };
  if (word) {
    out.length = word.length;
    out.masked = mask(word, state.guessed);
    if (player === state.setter) out.word = word;
  }
  return out;
}

const scores = (state) => state.score.slice();

module.exports = { MAX_WRONG, ROUNDS, create, applyMove, view, scores, normalizeWord, normalizeHint, mask };
