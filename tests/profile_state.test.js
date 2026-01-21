const assert = require("node:assert/strict");
const test = require("node:test");

let profileState;

test.before(async () => {
  profileState = await import("../static/js/profile-state.js");
});

const baseValues = {
  client_id: "client",
  client_secret: "secret",
  redirect_uri: "https://example.com/callback",
  authorization_code: "authcode",
  authorized_devices: ["111", "222"],
  fetch_concurrency: 12,
};

test("editor state starts read-only", () => {
  const editor = profileState.createEditorState();
  const state = editor.getState();

  assert.equal(state.isEditing, false);
  assert.equal(state.isDirty, false);
  assert.equal(editor.hasUnsavedChanges(), false);
});

test("enter edit mode and change value marks dirty", () => {
  const editor = profileState.createEditorState();
  editor.startEditing(baseValues);
  editor.updateDraft({ ...baseValues, client_id: "updated" });

  const state = editor.getState();
  assert.equal(state.isEditing, true);
  assert.equal(state.isDirty, true);
  assert.equal(editor.hasUnsavedChanges(), true);
});

test("cancel reverts to saved state", () => {
  const editor = profileState.createEditorState();
  editor.startEditing(baseValues);
  editor.updateDraft({ ...baseValues, client_secret: "new-secret" });
  editor.cancelEditing();

  const state = editor.getState();
  assert.equal(state.isEditing, false);
  assert.equal(state.isDirty, false);
  assert.deepEqual(state.draftValues, profileState.normalizeValues(baseValues));
  assert.equal(editor.hasUnsavedChanges(), false);
});

test("save persists updated values", () => {
  const editor = profileState.createEditorState();
  const updated = {
    ...baseValues,
    fetch_concurrency: 24,
    authorized_devices: ["111", "222", "333"],
  };

  editor.startEditing(baseValues);
  editor.updateDraft(updated);
  editor.commitDraft();

  const state = editor.getState();
  assert.equal(state.isEditing, true);
  assert.equal(state.isDirty, false);
  assert.deepEqual(state.savedValues, profileState.normalizeValues(updated));
  assert.equal(editor.hasUnsavedChanges(), false);
});

test("draft updates are ignored when not editing", () => {
  const editor = profileState.createEditorState();
  editor.updateDraft(baseValues);

  const state = editor.getState();
  assert.equal(state.isEditing, false);
  assert.equal(state.isDirty, false);
  assert.equal(editor.hasUnsavedChanges(), false);
});

test("normalizeValues trims inputs and normalizes devices", () => {
  const normalized = profileState.normalizeValues({
    client_id: " client ",
    client_secret: "secret ",
    redirect_uri: " https://example.com ",
    authorization_code: " code ",
    authorized_devices: " 111 , 222 ",
    fetch_concurrency: "0",
  });

  assert.equal(normalized.client_id, "client");
  assert.equal(normalized.client_secret, "secret");
  assert.equal(normalized.redirect_uri, "https://example.com");
  assert.equal(normalized.authorization_code, "code");
  assert.deepEqual(normalized.authorized_devices, ["111", "222"]);
  assert.equal(normalized.fetch_concurrency, 12);
});

test("areValuesEqual ignores equivalent normalized inputs", () => {
  const left = {
    client_id: "client",
    client_secret: "secret",
    redirect_uri: "https://example.com",
    authorization_code: "code",
    authorized_devices: ["111", "222"],
    fetch_concurrency: 12,
  };
  const right = {
    client_id: " client ",
    client_secret: "secret",
    redirect_uri: "https://example.com",
    authorization_code: "code",
    authorized_devices: "111,222",
    fetch_concurrency: "12",
  };

  assert.equal(profileState.areValuesEqual(left, right), true);
});
