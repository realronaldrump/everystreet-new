const DEFAULT_FETCH_CONCURRENCY = 12;

function normalizeDevices(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    return value.split(",");
  }
  return [];
}

function normalizeConcurrency(value) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_FETCH_CONCURRENCY;
  }
  return parsed;
}

function normalizeValues(values = {}) {
  const devices = normalizeDevices(values.authorized_devices).map((item) =>
    String(item || "").trim()
  );

  return {
    client_id: String(values.client_id || "").trim(),
    client_secret: String(values.client_secret || "").trim(),
    redirect_uri: String(values.redirect_uri || "").trim(),
    authorization_code: String(values.authorization_code || "").trim(),
    authorized_devices: devices,
    fetch_concurrency: normalizeConcurrency(values.fetch_concurrency),
  };
}

function cloneValues(values) {
  if (!values) {
    return null;
  }
  const normalized = normalizeValues(values);
  return {
    ...normalized,
    authorized_devices: [...normalized.authorized_devices],
  };
}

function areValuesEqual(left, right) {
  const a = normalizeValues(left || {});
  const b = normalizeValues(right || {});

  if (a.client_id !== b.client_id) {
    return false;
  }
  if (a.client_secret !== b.client_secret) {
    return false;
  }
  if (a.redirect_uri !== b.redirect_uri) {
    return false;
  }
  if (a.authorization_code !== b.authorization_code) {
    return false;
  }
  if (a.fetch_concurrency !== b.fetch_concurrency) {
    return false;
  }

  if (a.authorized_devices.length !== b.authorized_devices.length) {
    return false;
  }
  for (let i = 0; i < a.authorized_devices.length; i += 1) {
    if (a.authorized_devices[i] !== b.authorized_devices[i]) {
      return false;
    }
  }

  return true;
}

function createEditorState(initialValues = null) {
  let savedValues = initialValues ? cloneValues(initialValues) : null;
  let draftValues = savedValues ? cloneValues(savedValues) : null;
  let isEditing = false;
  let isDirty = false;

  function startEditing(values) {
    savedValues = cloneValues(values);
    draftValues = cloneValues(values);
    isEditing = true;
    isDirty = false;
  }

  function updateDraft(values) {
    if (!isEditing) {
      return;
    }
    draftValues = cloneValues(values);
    if (!savedValues) {
      isDirty = true;
      return;
    }
    isDirty = !areValuesEqual(savedValues, draftValues);
  }

  function commitDraft() {
    if (!isEditing) {
      return;
    }
    savedValues = cloneValues(draftValues || {});
    isDirty = false;
  }

  function cancelEditing() {
    isEditing = false;
    isDirty = false;
    draftValues = savedValues ? cloneValues(savedValues) : null;
  }

  function hasUnsavedChanges() {
    return Boolean(isEditing && isDirty);
  }

  function getState() {
    return {
      savedValues: cloneValues(savedValues),
      draftValues: cloneValues(draftValues),
      isEditing,
      isDirty,
    };
  }

  return {
    startEditing,
    updateDraft,
    commitDraft,
    cancelEditing,
    hasUnsavedChanges,
    getState,
    normalizeValues,
    areValuesEqual,
  };
}

const ProfileState = {
  DEFAULT_FETCH_CONCURRENCY,
  normalizeValues,
  areValuesEqual,
  createEditorState,
};

export {
  DEFAULT_FETCH_CONCURRENCY,
  ProfileState,
  areValuesEqual,
  createEditorState,
  normalizeValues,
};

export default ProfileState;
