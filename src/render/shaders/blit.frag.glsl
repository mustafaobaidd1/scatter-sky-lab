#version 300 es
// Upscales the (possibly reduced-resolution) sky image to the canvas with bilinear filtering.
precision mediump float;
uniform sampler2D uImage;
in vec2 vUv;
out vec4 outColor;
void main() {
  outColor = texture(uImage, vUv);
}
