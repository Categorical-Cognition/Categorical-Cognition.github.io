import * as THREE from "three";

const LABEL_FONT = "600 28px Inter, Arial, sans-serif";
const LABEL_PADDING_X = 12;
const LABEL_PADDING_Y = 7;
const LABEL_WORLD_HEIGHT = 0.42;
const LABEL_TEXTURE_PIXEL_RATIO = 2;
const LABEL_MAX_TEXTURE_DIMENSION = 2048;

function scaleLabelSprite(sprite, texture, size) {
  const { width, height } = texture.userData.size;
  const worldHeight = LABEL_WORLD_HEIGHT * size;
  sprite.scale.set((width / height) * worldHeight, worldHeight, 1);
}

function createLabelTexture(text) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  context.font = LABEL_FONT;
  const metrics = context.measureText(text);
  const logicalWidth = Math.ceil(metrics.width + LABEL_PADDING_X * 2);
  const logicalHeight = 28 + LABEL_PADDING_Y * 2;
  const pixelRatio = Math.max(
    1,
    Math.min(
      LABEL_TEXTURE_PIXEL_RATIO,
      LABEL_MAX_TEXTURE_DIMENSION / Math.max(logicalWidth, logicalHeight),
    ),
  );
  canvas.width = Math.ceil(logicalWidth * pixelRatio);
  canvas.height = Math.ceil(logicalHeight * pixelRatio);
  canvas.style.width = `${logicalWidth}px`;
  canvas.style.height = `${logicalHeight}px`;
  context.scale(pixelRatio, pixelRatio);

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, logicalWidth, logicalHeight);
  context.font = LABEL_FONT;
  context.fillStyle = "#000000";
  context.textBaseline = "middle";
  context.fillText(text, LABEL_PADDING_X, logicalHeight / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  texture.userData.size = { width: logicalWidth, height: logicalHeight };
  texture.userData.pixelRatio = pixelRatio;
  return texture;
}

export function createLabelSprite(text, size = 1) {
  const material = new THREE.SpriteMaterial({
    transparent: false,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.center.set(0, 0);
  sprite.renderOrder = 10;
  updateLabelSprite(sprite, text, size);
  return sprite;
}

export function updateLabelSprite(
  sprite,
  text,
  size = sprite.userData.labelSize ?? 1,
) {
  const labelText = String(text ?? "");
  if (
    sprite.userData.labelText === labelText &&
    sprite.userData.labelSize === size
  ) {
    return;
  }

  sprite.userData.labelText = labelText;
  sprite.userData.labelSize = size;
  if (!labelText) {
    sprite.material.map?.dispose();
    sprite.material.map = null;
    sprite.visible = false;
    return;
  }

  if (
    sprite.material.map &&
    sprite.material.map.userData.labelText !== labelText
  ) {
    sprite.material.map.dispose();
    sprite.material.map = null;
  }
  if (!sprite.material.map) {
    sprite.material.map = createLabelTexture(labelText);
    sprite.material.map.userData.labelText = labelText;
  }
  sprite.material.needsUpdate = true;
  scaleLabelSprite(sprite, sprite.material.map, size);
}

export function positionLabelSprite(sprite, position) {
  sprite.position.copy(position);
}

export function disposeLabelSprite(sprite) {
  sprite.material.map?.dispose();
  sprite.material.dispose();
}
