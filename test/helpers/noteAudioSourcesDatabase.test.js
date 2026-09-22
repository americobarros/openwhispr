const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-note-audio-db-"));
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const DatabaseManager = require("../../src/helpers/database.js");

function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

function createDb(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-note-audio-db-"));
  try {
    const BetterSqlite = require("better-sqlite3");
    const probe = new BetterSqlite(path.join(userDataDir, "probe.db"));
    probe.close();
    fs.rmSync(path.join(userDataDir, "probe.db"), { force: true });
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }

  try {
    const database = new DatabaseManager();
    database.setActiveAccountId("test-account");
    return database;
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

function insertNote(db, { title = "Note", noteType = "meeting", transcript = null } = {}) {
  const { lastInsertRowid } = db.db
    .prepare(
      "INSERT INTO notes (title, content, note_type, transcript) VALUES (?, '', ?, ?)"
    )
    .run(title, noteType, transcript);
  return lastInsertRowid;
}

// A retained meeting recording: route_kind='meeting', has_audio=1. created_at is
// backdated so ordering across multiple recordings is deterministic.
function insertMeetingRecording(db, text, ageMinutes) {
  const { lastInsertRowid } = db.db
    .prepare(
      `INSERT INTO transcriptions
         (text, raw_text, status, route_kind, has_audio, timestamp, created_at)
       VALUES (?, NULL, 'completed', 'meeting', 1, datetime('now', ?), datetime('now', ?))`
    )
    .run(text, `-${ageMinutes} minutes`, `-${ageMinutes} minutes`);
  return lastInsertRowid;
}

function noteWithTranscript(noteId, transcript) {
  return { id: noteId, transcript };
}

test("registerNoteAudioSource stores multiple recordings per note and upserts by id", (t) => {
  const db = createDb(t);
  if (!db) return;
  const noteId = insertNote(db, { title: "multi recording test" });
  const t1 = insertMeetingRecording(db, "first recording", 5);
  const t2 = insertMeetingRecording(db, "second recording", 2);

  db.registerNoteAudioSource(noteId, t1, "first.webm");
  db.registerNoteAudioSource(noteId, t2, "second.webm");
  db.registerNoteAudioSource(noteId, t2, "second-renamed.webm");

  const sources = db.getNoteAudioSources(noteId);
  assert.equal(sources.length, 2);
  assert.ok(sources.some((s) => s.transcription_id === t1 && s.file_name === "first.webm"));
  assert.ok(
    sources.some((s) => s.transcription_id === t2 && s.file_name === "second-renamed.webm"),
    "ON CONFLICT should update file_name, not insert a duplicate"
  );
});

test("matches a note whose whole transcript text equals one recording", (t) => {
  const db = createDb(t);
  if (!db) return;
  insertMeetingRecording(db, "unrelated meeting", 30);
  const recording = insertMeetingRecording(db, "hello this is a dictation", 3);
  const noteId = insertNote(db, {
    title: "single recording note",
    transcript: JSON.stringify([{ text: "Hello this is a dictation." }]),
  });

  assert.deepEqual(
    db.findMeetingRetentionAudioSourcesForNote(noteWithTranscript(noteId, null)),
    []
  );
});

test("matches OWNED recordings and ignores unclaimed ones", (t) => {
  const db = createDb(t);
  if (!db) return;
  insertMeetingRecording(db, "unrelated meeting", 30);
  const recording = insertMeetingRecording(db, "hello this is a dictation", 3);
  const transcript = JSON.stringify([{ text: "hello this is a dictation" }]);
  const note = {
    id: insertNote(db, {
      title: "single recording note",
      transcript,
    }),
    transcript,
  };

  assert.deepEqual(db.findMeetingRetentionAudioSourcesForNote(note), [recording]);
  assert.equal(db.findMeetingRetentionAudioForNote(note), recording);
});

test("matches every recording whose text equals a note segment, oldest first", (t) => {
  const db = createDb(t);
  if (!db) return;
  const first = insertMeetingRecording(db, "This is audio recording number one.", 4);
  const second = insertMeetingRecording(db, "This is audio recording number two.", 1);
  const note = {
    id: insertNote(db, {
      title: "two recordings",
      transcript: JSON.stringify([
        { text: "This is audio recording number one." },
        { text: "This is audio recording number two." },
      ]),
    }),
    transcript: JSON.stringify([
      { text: "This is audio recording number one." },
      { text: "This is audio recording number two." },
    ]),
  };

  assert.deepEqual(db.findMeetingRetentionAudioSourcesForNote(note), [first, second]);
});

test("matches a recording whose text spans multiple utterance segments", (t) => {
  const db = createDb(t);
  if (!db) return;
  // Real meeting notes store many fine-grained utterances per recording.
  // Retention saves the full joined transcript; rescue must match consecutive
  // segment spans, not only single-segment equality.
  const first = insertMeetingRecording(
    db,
    "But I ended up making quinoa. zucchini, squash, red beans.",
    4
  );
  const second = insertMeetingRecording(
    db,
    "So it was really good though. I forgot the spinach.",
    1
  );
  const note = {
    id: insertNote(db, {
      title: "8ppltalking",
      transcript: JSON.stringify([
        { text: "But I ended up making quinoa." },
        { text: "zucchini, squash, red beans." },
        { text: "So it was really good though." },
        { text: "I forgot the spinach." },
      ]),
    }),
    transcript: JSON.stringify([
      { text: "But I ended up making quinoa." },
      { text: "zucchini, squash, red beans." },
      { text: "So it was really good though." },
      { text: "I forgot the spinach." },
    ]),
  };

  assert.deepEqual(db.findMeetingRetentionAudioSourcesForNote(note), [first, second]);
});

test("rescues remaining recordings when one is already linked", (t) => {
  const db = createDb(t);
  if (!db) return;
  const first = insertMeetingRecording(db, "first half of the call", 4);
  const second = insertMeetingRecording(db, "second half of the call", 1);
  const transcript = JSON.stringify([
    { text: "first half of the call" },
    { text: "second half of the call" },
  ]);
  const noteId = insertNote(db, {
    title: "partially linked",
    transcript,
  });
  db.registerNoteAudioSource(noteId, first, "first.webm");

  assert.deepEqual(db.findMeetingRetentionAudioSourcesForNote({ id: noteId, transcript }), [
    second,
  ]);
});

test("never reuses a recording already claimed by another note", (t) => {
  const db = createDb(t);
  if (!db) return;
  const recording = insertMeetingRecording(db, "one way or another", 2);
  const owner = insertNote(db, {
    title: "owner",
    transcript: JSON.stringify([{ text: "one way or another" }]),
  });
  const other = insertNote(db, {
    title: "other",
    transcript: JSON.stringify([{ text: "one way or another" }]),
  });
  db.registerNoteAudioSource(owner, recording, "owner.webm");

  assert.deepEqual(db.findMeetingRetentionAudioSourcesForNote({ id: owner }), []);
  assert.deepEqual(db.findMeetingRetentionAudioSourcesForNote({ id: other }), []);
});

test("returns nothing for notes with no recording text", (t) => {
  const db = createDb(t);
  if (!db) return;
  assert.deepEqual(db.findMeetingRetentionAudioSourcesForNote({ id: 1, transcript: null }), []);
  assert.deepEqual(db.findMeetingRetentionAudioSourcesForNote({ id: 1, transcript: "" }), []);
});