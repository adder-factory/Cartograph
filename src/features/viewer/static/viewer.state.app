/* Central state and action registry for the static viewer.
   Existing modules still own rendering, but shared state mutations are
   mirrored here so debugging, smoke tests, and new features do not
   need to chase scattered globals. */

function cloneViewerStateValue(value) {
  if (value == null || typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function viewerStorageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {}
}

function readViewerJsonStorage(key, fallback, opts = {}) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (typeof opts.validate === 'function' && !opts.validate(parsed)) {
      viewerStorageRemove(key);
      return fallback;
    }
    return parsed;
  } catch {
    viewerStorageRemove(key);
    return fallback;
  }
}

function writeViewerJsonStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function createViewerStateStore(initial = {}) {
  const actions = Object.create(null);
  const state = {
    selection: {
      currentSymbolId: null,
      liveSymbolCache: null,
    },
    graph: {
      breadcrumbScope: null,
      densityMode: 'core',
      detailGroupingMode: 'grouped',
      edgeLensMode: 'all',
      lastPayload: null,
      layoutQuality: 'balanced',
      visibilityStats: null,
    },
    navigation: {
      history: [],
      index: -1,
    },
    edgeInspection: {
      hoveredEdgeId: null,
      selectedEdgeId: null,
    },
  };

  const api = {
    state,
    actions,
    setSelection(patch = {}) {
      if ('currentSymbolId' in patch) state.selection.currentSymbolId = patch.currentSymbolId || null;
      if ('liveSymbolCache' in patch) state.selection.liveSymbolCache = patch.liveSymbolCache || null;
      return state.selection;
    },
    setGraph(patch = {}) {
      if ('breadcrumbScope' in patch) state.graph.breadcrumbScope = patch.breadcrumbScope || null;
      if ('densityMode' in patch) state.graph.densityMode = patch.densityMode || 'core';
      if ('detailGroupingMode' in patch) state.graph.detailGroupingMode = patch.detailGroupingMode || 'grouped';
      if ('edgeLensMode' in patch) state.graph.edgeLensMode = patch.edgeLensMode || 'all';
      if ('lastPayload' in patch) state.graph.lastPayload = cloneViewerStateValue(patch.lastPayload);
      if ('layoutQuality' in patch) state.graph.layoutQuality = patch.layoutQuality || 'balanced';
      if ('visibilityStats' in patch) state.graph.visibilityStats = cloneViewerStateValue(patch.visibilityStats);
      return state.graph;
    },
    setNavigation(history = [], index = -1) {
      state.navigation.history = Array.isArray(history)
        ? history.map((entry) => ({
            id: entry?.id || '',
            label: entry?.label || entry?.id || '',
          })).filter((entry) => entry.id)
        : [];
      state.navigation.index = Number.isFinite(Number(index)) ? Number(index) : -1;
      return state.navigation;
    },
    setEdgeInspection(hoveredEdgeId = null, selectedEdgeId = null) {
      state.edgeInspection.hoveredEdgeId = hoveredEdgeId || null;
      state.edgeInspection.selectedEdgeId = selectedEdgeId || null;
      return state.edgeInspection;
    },
    registerAction(name, fn) {
      if (typeof name === 'string' && name && typeof fn === 'function') actions[name] = fn;
      return fn;
    },
    runAction(name, ...args) {
      const action = actions[name];
      if (typeof action !== 'function') return undefined;
      return action(...args);
    },
    snapshot() {
      return cloneViewerStateValue({
        selection: state.selection,
        graph: state.graph,
        navigation: state.navigation,
        edgeInspection: state.edgeInspection,
        actionNames: Object.keys(actions).sort(),
      });
    },
  };

  if (initial.selection) api.setSelection(initial.selection);
  if (initial.graph) api.setGraph(initial.graph);
  if (initial.navigation) api.setNavigation(initial.navigation.history, initial.navigation.index);
  if (initial.edgeInspection) {
    api.setEdgeInspection(initial.edgeInspection.hoveredEdgeId, initial.edgeInspection.selectedEdgeId);
  }
  return api;
}

const viewerState = createViewerStateStore();
const viewerActions = viewerState.actions;

function syncViewerSelectionState(currentSymbolId, liveSymbolCache) {
  return viewerState.setSelection({ currentSymbolId, liveSymbolCache });
}

function syncViewerGraphState(patch = {}) {
  return viewerState.setGraph(patch);
}

function syncViewerNavigationState(history, index) {
  return viewerState.setNavigation(history, index);
}

function syncViewerEdgeInspectionState(hoveredEdgeId, selectedEdgeId) {
  return viewerState.setEdgeInspection(hoveredEdgeId, selectedEdgeId);
}

function viewerCurrentSymbolId() {
  return viewerState.state.selection.currentSymbolId || null;
}

function viewerLiveSymbolCache() {
  return viewerState.state.selection.liveSymbolCache || null;
}

function viewerGraphMode(key, fallback = null) {
  const value = viewerState.state.graph[key];
  return value == null || value === '' ? fallback : value;
}

function registerViewerAction(name, fn) {
  return viewerState.registerAction(name, fn);
}

function runViewerAction(name, ...args) {
  return viewerState.runAction(name, ...args);
}

globalThis.viewerState = viewerState;
globalThis.viewerActions = viewerActions;
globalThis.readViewerJsonStorage = readViewerJsonStorage;
globalThis.viewerCurrentSymbolId = viewerCurrentSymbolId;
globalThis.viewerLiveSymbolCache = viewerLiveSymbolCache;
globalThis.viewerGraphMode = viewerGraphMode;
globalThis.viewerStorageRemove = viewerStorageRemove;
globalThis.writeViewerJsonStorage = writeViewerJsonStorage;
globalThis.registerViewerAction = registerViewerAction;
globalThis.runViewerAction = runViewerAction;
