// Central registry for effect & transition definitions.
// Definitions are registered by engine modules; the model reads defaults from here.

export const registry = {
  videoEffects: new Map(),
  audioEffects: new Map(),
  videoTransitions: new Map(),
  audioTransitions: new Map(),
};

export function registerVideoEffect(def) {
  def.kind = 'video';
  registry.videoEffects.set(def.id, def);
  return def;
}
export function registerAudioEffect(def) {
  def.kind = 'audio';
  registry.audioEffects.set(def.id, def);
  return def;
}
export function registerVideoTransition(def) {
  def.kind = 'video';
  def.isTransition = true;
  registry.videoTransitions.set(def.id, def);
  return def;
}
export function registerAudioTransition(def) {
  def.kind = 'audio';
  def.isTransition = true;
  registry.audioTransitions.set(def.id, def);
  return def;
}

export function getEffectDef(id) {
  return registry.videoEffects.get(id) || registry.audioEffects.get(id) || null;
}
export function getTransitionDef(id) {
  return registry.videoTransitions.get(id) || registry.audioTransitions.get(id) || null;
}
