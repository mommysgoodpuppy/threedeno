import * as THREE from "three/webgpu";

export enum RuleSet {
  GOLXR, // Original custom rule with spawner
  LIFE_5766, // B6/S567 classic 3D life
  LIFE_25D, // 2.5D rule: B3/S23 (plane) + limited cross-layer
}

const CURRENT_RULESET = RuleSet.GOLXR; // TOGGLE HERE
const ENABLE_GOL_DEBUG = false;
const AUTO_RESEED_ON_EXTINCTION = true;

// Define the structure of our game state
interface GameState {
  size: number;
  grid: Record<number, Record<number, Record<number, number>>> | null;
  nextGrid: Record<number, Record<number, Record<number, number>>> | null;
  cellOpacity: Record<number, Record<number, Record<number, number>>> | null; // 0-1 opacity for fade
  instancedMesh: THREE.InstancedMesh | null;
  edgeInstancedMesh: THREE.InstancedMesh | null;
  maxInstances: number;
  activeInstances: number;
  lastUpdate: number;
  updateInterval: number;
  recentlyAdded: Record<number, Record<number, Record<number, number>>>;
  cellMemory: number;
  bias: number;
  spawnerPosition: THREE.Vector3;
  spawnerMesh: THREE.Mesh | null;
  interactionRadius: number;
  fadeSpeed: number; // How fast cells fade in/out per frame
  currentRuleSet: RuleSet;
}

// State
const gameState: GameState = {
  size: 20,
  grid: null,
  nextGrid: null,
  cellOpacity: null,
  instancedMesh: null,
  edgeInstancedMesh: null,
  maxInstances: 20 * 20 * 20,
  activeInstances: 0,
  lastUpdate: 0,
  updateInterval: 66, // Speed of update (10x slower)
  recentlyAdded: {},
  cellMemory: 700,
  bias: 0.59,
  spawnerPosition: new THREE.Vector3(),
  spawnerMesh: null,
  interactionRadius: 0.01, // Radius for spawner (smaller)
  fadeSpeed: 0.05, // Fade speed per frame (slower for smoother effect)
  currentRuleSet: CURRENT_RULESET,
};

let golRoot: THREE.Group | null = null;
let lastLoggedInstanceCount = -1;
let _boundingBoxMesh: THREE.Mesh | null = null;

const debugLog = (...args: unknown[]) => {
  if (ENABLE_GOL_DEBUG) {
    console.log("[GOL]", ...args);
  }
};

const createBoundingBox = (): THREE.Mesh => {
  const boxSize = gameState.size * 0.011;
  const geometry = new THREE.BoxGeometry(boxSize, boxSize, boxSize);
  const material = new THREE.MeshBasicMaterial({
    color: 0x000000,
    side: THREE.BackSide,
  });
  const boundingBox = new THREE.Mesh(geometry, material);
  return boundingBox;
};

// Initialize recentlyAdded structure
const initRecentlyAdded = () => {
  gameState.recentlyAdded = {};
  for (let x = 0; x < gameState.size; x++) {
    gameState.recentlyAdded[x] = {};
    for (let y = 0; y < gameState.size; y++) {
      gameState.recentlyAdded[x][y] = {};
      for (let z = 0; z < gameState.size; z++) {
        gameState.recentlyAdded[x][y][z] = 0;
      }
    }
  }
};

// Initialize cell opacity grid (all cells start at 0 opacity)
const initCellOpacity = () => {
  gameState.cellOpacity = {};
  for (let x = 0; x < gameState.size; x++) {
    gameState.cellOpacity[x] = {};
    for (let y = 0; y < gameState.size; y++) {
      gameState.cellOpacity[x][y] = {};
      for (let z = 0; z < gameState.size; z++) {
        gameState.cellOpacity[x][y][z] = 0;
      }
    }
  }
};

const createCubeMaterials = () => {
  // Main cube material - "Glowing" aesthetic
  // using Phong for shininess + Emissive for glow illusion
  const mainMaterial = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    emissive: 0x000000,
    specular: 0x111111,
    shininess: 30,
    transparent: true,
    opacity: 1,
    dithering: true, // Enable dithering as requested
  });

  // Black edge material - transparent for fading
  const edgeMaterial = new THREE.MeshBasicMaterial({
    color: 0x000000,
    side: THREE.BackSide,
    transparent: true,
    opacity: 1,
    dithering: true,
  });

  return [mainMaterial, edgeMaterial];
};

const matrix = new THREE.Matrix4();
const position = new THREE.Vector3();
const quaternion = new THREE.Quaternion();
const scale = new THREE.Vector3(1, 1, 1);

const createEmptyGrid = (
  size: number,
): Record<number, Record<number, Record<number, number>>> => {
  const grid: Record<number, Record<number, Record<number, number>>> = {};
  for (let x = 0; x < size; x++) {
    grid[x] = {};
    for (let y = 0; y < size; y++) {
      grid[x][y] = {};
      for (let z = 0; z < size; z++) {
        grid[x][y][z] = 0;
      }
    }
  }
  return grid;
};

const seedInitialPattern = () => {
  if (!gameState.grid) return;

  if (gameState.currentRuleSet === RuleSet.LIFE_5766) {
    // 5766 Initialization: ~20% random fill in a centered sub-cube
    const center = Math.floor(gameState.size / 2);
    const range = Math.floor(gameState.size / 2) - 2; // Fill most of the space but leave margin

    for (let x = center - range; x <= center + range; x++) {
      for (let y = center - range; y <= center + range; y++) {
        for (let z = center - range; z <= center + range; z++) {
          if (Math.random() < 0.20) {
            if (
              x >= 0 && x < gameState.size &&
              y >= 0 && y < gameState.size &&
              z >= 0 && z < gameState.size
            ) {
              gameState.grid[x][y][z] = 1;
              gameState.recentlyAdded[x][y][z] = Date.now();
            }
          }
        }
      }
    }
    debugLog("Seeded LIFE_5766 with ~20% density.");
    return;
  }

  if (gameState.currentRuleSet === RuleSet.LIFE_25D) {
    // 2.5D Initialization: ~30% random fill (typical for standard Life-like cellular automata)
    const center = Math.floor(gameState.size / 2);
    const range = Math.floor(gameState.size / 2) - 2;

    for (let x = center - range; x <= center + range; x++) {
      for (let y = center - range; y <= center + range; y++) {
        for (let z = center - range; z <= center + range; z++) {
          if (Math.random() < 0.30) {
            if (
              x >= 0 && x < gameState.size &&
              y >= 0 && y < gameState.size &&
              z >= 0 && z < gameState.size
            ) {
              gameState.grid[x][y][z] = 1;
              gameState.recentlyAdded[x][y][z] = Date.now();
            }
          }
        }
      }
    }
    debugLog("Seeded LIFE_25D with ~30% density.");
    return;
  }

  // GOLXR Initialization
  const center = Math.floor(gameState.size / 2);
  // Simple shape
  const seeds = [
    [0, 0, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];

  // Add some random noise
  for (let i = 0; i < 50; i++) {
    seeds.push([
      Math.floor(Math.random() * 10) - 5,
      Math.floor(Math.random() * 10) - 5,
      Math.floor(Math.random() * 10) - 5,
    ]);
  }

  seeds.forEach(([dx, dy, dz]) => {
    const x = center + dx;
    const y = center + dy;
    const z = center + dz;
    if (
      gameState.grid &&
      x >= 0 && x < gameState.size &&
      y >= 0 && y < gameState.size &&
      z >= 0 && z < gameState.size
    ) {
      gameState.grid[x][y][z] = 1;
      gameState.recentlyAdded[x][y][z] = Date.now();
    }
  });

  debugLog("Seeded initial pattern with", seeds.length, "cells.");
};

const countNeighbors = (x: number, y: number, z: number): number => {
  if (!gameState.grid) return 0;
  let count = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;

        const nx = x + dx;
        const ny = y + dy;
        const nz = z + dz;

        if (
          nx >= 0 && nx < gameState.size &&
          ny >= 0 && ny < gameState.size &&
          nz >= 0 && nz < gameState.size
        ) {
          count += gameState.grid[nx][ny][nz];
        }
      }
    }
  }
  return count;
};

// Helper for 2.5D neighbor counting
const countNeighbors25D = (
  x: number,
  y: number,
  z: number,
): { plane: number; cross: number } => {
  if (!gameState.grid) return { plane: 0, cross: 0 };
  let plane = 0;
  let cross = 0;

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;

        const nx = x + dx;
        const ny = y + dy;
        const nz = z + dz;

        if (
          nx >= 0 && nx < gameState.size &&
          ny >= 0 && ny < gameState.size &&
          nz >= 0 && nz < gameState.size
        ) {
          if (gameState.grid[nx][ny][nz] === 1) {
            if (dz === 0) {
              plane++;
            } else {
              cross++;
            }
          }
        }
      }
    }
  }
  return { plane, cross };
};

const updateGrid = () => {
  if (!gameState.grid || !gameState.nextGrid) return;
  const currentTime = Date.now();

  const biasMultiplier = (gameState.bias - 0.5) * 2; // -1 to 1
  const survivalBias = Math.max(0, Math.min(0.9, biasMultiplier * 0.4));
  const birthBias = Math.max(0, Math.min(0.9, biasMultiplier * 0.4));

  for (let x = 0; x < gameState.size; x++) {
    for (let y = 0; y < gameState.size; y++) {
      for (let z = 0; z < gameState.size; z++) {
        const currentState = gameState.grid[x][y][z];
        const lastAddedTime = gameState.recentlyAdded[x][y][z];

        // --- Ruleset Logic ---

        if (gameState.currentRuleSet === RuleSet.LIFE_5766) {
          const neighbors = countNeighbors(x, y, z);
          // Rule: B6/S567
          // Birth: exactly 6
          // Survival: 5, 6, 7
          if (currentState === 1) {
            if (neighbors >= 5 && neighbors <= 7) {
              gameState.nextGrid[x][y][z] = 1;
            } else {
              gameState.nextGrid[x][y][z] = 0;
            }
          } else {
            if (neighbors === 6) {
              gameState.nextGrid[x][y][z] = 1;
            } else {
              gameState.nextGrid[x][y][z] = 0;
            }
          }
        } else if (gameState.currentRuleSet === RuleSet.LIFE_25D) {
          // 2.5D Rules
          // Birth: Plane == 3 AND Cross <= 1
          // Survival: Plane == 2,3 AND Cross <= 1
          const { plane, cross } = countNeighbors25D(x, y, z);

          if (currentState === 1) {
            // Survival
            if ((plane === 2 || plane === 3) && cross <= 1) {
              gameState.nextGrid[x][y][z] = 1;
            } else {
              gameState.nextGrid[x][y][z] = 0;
            }
          } else {
            // Birth
            if (plane === 3 && cross <= 1) {
              gameState.nextGrid[x][y][z] = 1;
            } else {
              gameState.nextGrid[x][y][z] = 0;
            }
          }
        } else {
          // Default: GOLXR (Original Custom Rules with memory and bias)
          const neighbors = countNeighbors(x, y, z);

          if (currentTime - lastAddedTime < gameState.cellMemory) {
            gameState.nextGrid[x][y][z] = 1;
            continue; // Keep young cells alive
          }

          if (currentState === 1) {
            if (neighbors === 4) {
              gameState.nextGrid[x][y][z] =
                (Math.random() > (0.1 - survivalBias)) ? 1 : 0;
            } else if (neighbors === 3 || neighbors === 5) {
              gameState.nextGrid[x][y][z] =
                (Math.random() > (0.4 - survivalBias)) ? 1 : 0;
            } else if (neighbors > 5) {
              gameState.nextGrid[x][y][z] =
                (Math.random() > (0.99 - survivalBias)) ? 1 : 0;
            } else {
              gameState.nextGrid[x][y][z] =
                (Math.random() > (0.99 - survivalBias)) ? 1 : 0;
            }
          } else {
            if (neighbors === 4) {
              gameState.nextGrid[x][y][z] = (Math.random() > (0.7 - birthBias))
                ? 1
                : 0;
            } else if (neighbors === 3) {
              gameState.nextGrid[x][y][z] =
                (Math.random() > (0.95 - birthBias / 2)) ? 1 : 0;
            } else {
              gameState.nextGrid[x][y][z] = 0;
            }
          }

          // Random death for old cells
          if (gameState.nextGrid[x][y][z] === 1) {
            if (Math.random() > (0.95 + survivalBias)) {
              gameState.nextGrid[x][y][z] = 0;
            }
          }
        }
      }
    }
  }

  // Swap grids
  [gameState.grid, gameState.nextGrid] = [gameState.nextGrid, gameState.grid];
  updateInstancedMesh();

  if (AUTO_RESEED_ON_EXTINCTION && gameState.activeInstances === 0) {
    debugLog("All cells extinct - reseeding.");
    seedInitialPattern();
    updateInstancedMesh();
  }
};

const updateInstancedMesh = () => {
  if (!gameState.instancedMesh || !gameState.grid || !gameState.cellOpacity) {
    return;
  }
  let instanceCount = 0;

  const bgColor = new THREE.Color(0x202020); // Match scene background
  const time = Date.now() * 0.0005; // Time factor for color cycling

  for (let x = 0; x < gameState.size; x++) {
    for (let y = 0; y < gameState.size; y++) {
      for (let z = 0; z < gameState.size; z++) {
        const opacity = gameState.cellOpacity[x][y][z];
        // Only render cells with some opacity
        if (opacity > 0.01) {
          position.set(
            (x - gameState.size / 2) * 0.011,
            (y - gameState.size / 2) * 0.011,
            (z - gameState.size / 2) * 0.011,
          );

          // Keep scale constant (no size animation)
          scale.set(1, 1, 1);

          matrix.compose(position, quaternion, scale);
          gameState.instancedMesh.setMatrixAt(instanceCount, matrix);

          // Calculate Color: Mostly white, rare red
          const cellColor = new THREE.Color(0xFFFFFF);
          // Use a stable hash for randomness so a cell maintains its color
          const hash = Math.sin(x * 12.9898 + y * 78.233 + z * 54.53) *
            43758.5453;
          if (Math.abs(hash % 1) < 0.01) { // 1% chance of being red
            cellColor.setHex(0xFF0000);
          }

          // Fade color towards background to simulate opacity
          // Aggressive curve: keep full bright mostly
          // We blend to bgColor. t=0 is full color, t=1 is bgColor.
          // We want t to stay close to 0 effectively, then ramp up to 1 at the end.
          // current opacity is 0..1. 1 is visible.
          // linear lerp uses (1 - opacity).
          // We want to use something smaller than (1 - opacity) generally.
          // Power of 20 keeps it bright until very low opacity
          // Opacity 0.2 -> (0.8)^20 ~= 0.01 (Still 99% bright)
          // Opacity 0.1 -> (0.9)^20 ~= 0.12 (starting to fade)
          // Opacity 0.05 -> (0.95)^20 ~= 0.35
          const blendFactor = Math.pow(1 - opacity, 20);

          const blendedColor = cellColor.clone().lerp(bgColor, blendFactor);

          gameState.instancedMesh.setColorAt(instanceCount, blendedColor);

          if (gameState.edgeInstancedMesh) {
            gameState.edgeInstancedMesh.setMatrixAt(instanceCount, matrix);
            // Edge fades from black towards background
            const blendedBlack = new THREE.Color(0x000000).lerp(
              bgColor,
              blendFactor,
            );
            gameState.edgeInstancedMesh.setColorAt(instanceCount, blendedBlack);
          }
          instanceCount++;
        }
      }
    }
  }

  gameState.instancedMesh.count = instanceCount;
  // @ts-ignore: instanceMatrix definition might be incomplete in some three types
  gameState.instancedMesh.instanceMatrix.needsUpdate = true;
  if (gameState.instancedMesh.instanceColor) {
    gameState.instancedMesh.instanceColor.needsUpdate = true;
  }

  if (gameState.edgeInstancedMesh) {
    gameState.edgeInstancedMesh.count = instanceCount;
    // @ts-ignore: instanceMatrix definition might be incomplete
    gameState.edgeInstancedMesh.instanceMatrix.needsUpdate = true;
    if (gameState.edgeInstancedMesh.instanceColor) {
      gameState.edgeInstancedMesh.instanceColor.needsUpdate = true;
    }
  }

  gameState.activeInstances = instanceCount;
  if (ENABLE_GOL_DEBUG && instanceCount !== lastLoggedInstanceCount) {
    lastLoggedInstanceCount = instanceCount;
    debugLog("Active instances:", instanceCount);
  }
};

// Update cell opacities - fade in alive cells, fade out dead cells
const updateCellOpacities = () => {
  if (!gameState.grid || !gameState.cellOpacity) return;

  let hasChanges = false;
  const fadeSpeed = gameState.fadeSpeed;

  for (let x = 0; x < gameState.size; x++) {
    for (let y = 0; y < gameState.size; y++) {
      for (let z = 0; z < gameState.size; z++) {
        const isAlive = gameState.grid[x][y][z] === 1;
        const currentOpacity = gameState.cellOpacity[x][y][z];

        if (isAlive && currentOpacity < 1) {
          // Fade in
          gameState.cellOpacity[x][y][z] = Math.min(
            1,
            currentOpacity + fadeSpeed,
          );
          hasChanges = true;
        } else if (!isAlive && currentOpacity > 0) {
          // Fade out
          gameState.cellOpacity[x][y][z] = Math.max(
            0,
            currentOpacity - fadeSpeed,
          );
          hasChanges = true;
        }
      }
    }
  }

  if (hasChanges) {
    updateInstancedMesh();
  }
};

export const init = (scene: THREE.Scene, _renderer: THREE.Renderer) => {
  golRoot = new THREE.Group();
  golRoot.name = "SimpleGOLRoot";
  scene.add(golRoot);

  const cubeGeom = new THREE.BoxGeometry(0.008, 0.008, 0.008);
  const [mainMaterial, edgeMaterial] = createCubeMaterials();

  gameState.instancedMesh = new THREE.InstancedMesh(
    cubeGeom,
    mainMaterial,
    gameState.maxInstances,
  );
  gameState.instancedMesh.castShadow = true;
  gameState.instancedMesh.receiveShadow = true;

  const edgeGeom = new THREE.BoxGeometry(0.0085, 0.0085, 0.0085);
  gameState.edgeInstancedMesh = new THREE.InstancedMesh(
    edgeGeom,
    edgeMaterial,
    gameState.maxInstances,
  );

  gameState.grid = createEmptyGrid(gameState.size);
  gameState.nextGrid = createEmptyGrid(gameState.size);
  initRecentlyAdded();
  initCellOpacity();
  seedInitialPattern();
  updateInstancedMesh();

  const boundingBox = createBoundingBox();
  golRoot.add(boundingBox);
  _boundingBoxMesh = boundingBox;

  golRoot.add(gameState.instancedMesh);
  if (gameState.edgeInstancedMesh) golRoot.add(gameState.edgeInstancedMesh);

  if (gameState.instancedMesh) {
    gameState.instancedMesh.count = gameState.activeInstances;
  }
  if (gameState.edgeInstancedMesh) {
    gameState.edgeInstancedMesh.count = gameState.activeInstances;
  }

  // Create Spawner Mesh (Only relevant for GOLXR, but we create it anyway and toggle visibility/logic)
  const spawnerGeo = new THREE.SphereGeometry(
    gameState.interactionRadius,
    16,
    16,
  );
  const spawnerMat = new THREE.MeshBasicMaterial({
    color: 0xff0000,
    wireframe: true,
    transparent: true,
    opacity: 0.0,
    visible: false,
  });
  gameState.spawnerMesh = new THREE.Mesh(spawnerGeo, spawnerMat);
  // Only add/show spawner if in GOLXR mode
  if (gameState.currentRuleSet === RuleSet.GOLXR) {
    golRoot.add(gameState.spawnerMesh);
  } else {
    gameState.spawnerMesh.visible = false;
  }

  if (golRoot) {
    debugLog("SimpleGOL initialized.");
  }
};

export const animate = () => {
  const currentTime = Date.now();

  // Spawner Logic (only if GOLXR)
  if (gameState.currentRuleSet === RuleSet.GOLXR) {
    // Move spawner automatically
    const time = currentTime * 0.001;
    gameState.spawnerPosition.set(
      Math.sin(time) * 0.05,
      Math.cos(time * 0.7) * 0.05,
      Math.sin(time * 0.5) * 0.05,
    );

    if (gameState.spawnerMesh) {
      gameState.spawnerMesh.position.copy(gameState.spawnerPosition);
    }

    // Activate cells near spawner
    addCellsNearSpawner();
  }

  if (currentTime - gameState.lastUpdate > gameState.updateInterval) {
    updateGrid();
    gameState.lastUpdate = currentTime;
  }

  // Update cell opacity for fade in/out effect (every frame)
  updateCellOpacities();

  if (golRoot) {
    golRoot.rotation.y += 0.005;
  }
};

const addCellsNearSpawner = () => {
  if (!gameState.grid) return;
  let needsUpdate = false;
  const currentTime = Date.now();
  const spawnerPos = gameState.spawnerPosition;
  const interactionRadius = gameState.interactionRadius;
  const center = gameState.size / 2;
  // Simple exhaustive check (30^3 is small enough)
  for (let x = 0; x < gameState.size; x++) {
    for (let y = 0; y < gameState.size; y++) {
      for (let z = 0; z < gameState.size; z++) {
        if (gameState.grid[x][y][z] === 0) {
          position.set(
            (x - center) * 0.011,
            (y - center) * 0.011,
            (z - center) * 0.011,
          );
          if (position.distanceTo(spawnerPos) < interactionRadius) {
            gameState.grid[x][y][z] = 1;
            gameState.recentlyAdded[x][y][z] = currentTime;
            needsUpdate = true;
          }
        }
      }
    }
  }

  if (needsUpdate) {
    updateInstancedMesh();
  }
};

export const getRootObject = (): THREE.Object3D | null => golRoot;
