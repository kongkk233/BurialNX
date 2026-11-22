/* Synthetic game-neutral MV runtime fixture: executed only by accept:package:runtime. */
globalThis.SceneManager = {
  _scene: null,
  _nextScene: null,
  started: false,
  run(SceneClass) {
    this._scene = new SceneClass();
    this.started = true;
  },
};
globalThis.Scene_Boot = function Scene_Boot() {};
