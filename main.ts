import * as THREE from "three/webgpu";
import { initSDL } from "./src/sdl_platform.ts";
import * as GOL from "./src/GameOfLife.ts";

const WIDTH = 800;
const HEIGHT = 600;

// Track current dimensions for resize handling
let currentWidth = WIDTH;
let currentHeight = HEIGHT;

// Forward declarations for resize handler
let renderer: THREE.WebGPURenderer;
let camera: THREE.PerspectiveCamera;

// Initialize SDL2, WebGPU, and Window
const {
  sdl2,
  window,
  surface,
  canvas,
  canvasContext,
  device,
  pollEvents,
  cleanup,
  resizeSurface,
} = await initSDL(WIDTH, HEIGHT, {
  onResize: (newWidth, newHeight) => {
    // Skip duplicate resize events or invalid sizes
    if (newWidth === currentWidth && newHeight === currentHeight) return;
    if (newWidth <= 0 || newHeight <= 0) return;

    // Store pending resize - will be applied in the render loop
    pendingResize = { width: newWidth, height: newHeight };
  },
});

// Pending resize state - applied in render loop to avoid blocking during drag
let pendingResize: { width: number; height: number } | null = null;

function applyPendingResize() {
  if (!pendingResize) return;

  const { width: newWidth, height: newHeight } = pendingResize;
  pendingResize = null;

  // Skip if dimensions haven't actually changed
  if (newWidth === currentWidth && newHeight === currentHeight) return;

  currentWidth = newWidth;
  currentHeight = newHeight;

  // Resize the surface and reconfigure the context
  resizeSurface(newWidth, newHeight);

  // Update renderer size
  if (renderer) {
    renderer.setSize(newWidth, newHeight);
  }

  // Update camera aspect ratio
  if (camera) {
    camera.aspect = newWidth / newHeight;
    camera.updateProjectionMatrix();
  }

  console.log(`Window resized to ${newWidth}x${newHeight}`);
}

// Scene Setup
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202020);

camera = new THREE.PerspectiveCamera(75, WIDTH / HEIGHT, 0.1, 1000);
camera.position.z = 0.22; // Moved closer as the GOL grid is small (approx 0.3 units)

// Debug: Add a light just in case materials need it (BasicMaterial doesn't, but good practice)
const light = new THREE.DirectionalLight(0xffffff, 3);
light.position.set(1, 2, 1);
light.castShadow = true;
light.shadow.mapSize.width = 4096;
light.shadow.mapSize.height = 4096;
light.shadow.camera.near = 0.1;
light.shadow.camera.far = 10;
// Scene is very small (~0.25 units), so we tighten the shadow camera
const d = 0.3;
light.shadow.camera.left = -d;
light.shadow.camera.right = d;
light.shadow.camera.top = d;
light.shadow.camera.bottom = -d;
light.shadow.bias = -0.0005;
scene.add(light);

const ambientLight = new THREE.AmbientLight(0x404040);
scene.add(ambientLight);

// Renderer Setup
console.log("Creating WebGPURenderer");
renderer = new THREE.WebGPURenderer({
  canvas,
  context: canvasContext,
  device,
  antialias: true, // Use antialias if possible
});
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setSize(WIDTH, HEIGHT);
console.log("Initializing WebGPURenderer");
await renderer.init();
console.log("WebGPURenderer initialized");

// Initialize Game of Life
console.log("Initializing Game of Life");
GOL.init(scene, renderer);

// Main Loop
let running = true;
let frame = 0;
console.log("Entering render loop");

const rAF = (globalThis as any).requestAnimationFrame;

function render() {
  if (!running) {
    console.log("Cleaning up...");
    cleanup();
    console.log("Shutdown complete");
    Deno.exit(0);
    return;
  }

  // Poll events (returns false if quit requested)
  if (!pollEvents()) {
    console.log("Quit requested");
    running = false;
  }

  // Apply any pending resize (deferred from event handler)
  applyPendingResize();

  GOL.animate();

  try {
    renderer.render(scene, camera);
    surface.present();
  } catch (e) {
    console.error("Render error:", e);
    running = false;
  }

  frame++;
  rAF(render);
}

rAF(render);
