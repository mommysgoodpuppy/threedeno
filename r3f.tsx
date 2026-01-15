import React, { useRef } from "react";
import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import { createRoot, extend, addAfterEffect, useFrame, ThreeToJSXElements } from "@react-three/fiber";

// deno-lint-ignore no-explicit-any
extend(THREE as any);

declare module "@react-three/fiber" {
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> { }
}

const WIDTH = 800;
const HEIGHT = 600;
const BUILD_OS = Deno.build.os;

//#region Polyfills
// deno-lint-ignore no-explicit-any
const globalAny = globalThis as any;

// rAF polyfill
type RafCallback = (time: number) => void;
if (!globalAny.requestAnimationFrame) {
  globalAny.requestAnimationFrame = (cb: RafCallback): number => {
    return setTimeout(() => {
      try {
        cb(performance.now());
      } catch (e) {
        console.error("Error in rAF callback:", e);
      }
    }, 16) as unknown as number;
  };
}
if (!globalAny.cancelAnimationFrame) {
  globalAny.cancelAnimationFrame = (id: number) => {
    clearTimeout(id as unknown as number);
  };
}

// DOM polyfills for R3F
class ResizeObserver {
  observe() { }
  unobserve() { }
  disconnect() { }
}
globalAny.ResizeObserver = ResizeObserver;

if (!globalAny.window) globalAny.window = globalAny;
if (!globalAny.document) {
  globalAny.document = {
    createElement: (tag: string) => {
      if (tag === "canvas") {
        return {
          style: {},
          addEventListener: () => { },
          removeEventListener: () => { },
          getContext: () => null,
        };
      }
      return {
        style: {},
        appendChild: () => { },
        removeChild: () => { },
        addEventListener: () => { },
        removeEventListener: () => { },
      };
    },
    addEventListener: () => { },
    removeEventListener: () => { },
  };
}
if (!globalAny.HTMLElement) {
  globalAny.HTMLElement = class HTMLElement { };
}
if (!globalAny.CustomEvent) {
  globalAny.CustomEvent = class CustomEvent {
    // deno-lint-ignore no-explicit-any
    constructor(public type: string, public detail: any) { }
  };
}
//#endregion

//#region SDL2 FFI
console.log("Loading SDL2 library");
const sdl2 = Deno.dlopen("SDL2", {
  SDL_Init: { parameters: ["u32"], result: "i32" },
  SDL_Quit: { parameters: [], result: "void" },
  SDL_CreateWindow: {
    parameters: ["buffer", "i32", "i32", "i32", "i32", "u32"],
    result: "pointer",
  },
  SDL_DestroyWindow: { parameters: ["pointer"], result: "void" },
  SDL_GetWindowWMInfo: { parameters: ["pointer", "pointer"], result: "i32" },
  SDL_GetVersion: { parameters: ["pointer"], result: "void" },
  SDL_PollEvent: { parameters: ["pointer"], result: "i32" },
});

const enc = new TextEncoder();
function asCString(text: string): Uint8Array {
  return enc.encode(`${text}\0`);
}

const SDL_INIT_VIDEO = 0x00000020;
const SDL_WINDOW_SHOWN = 0x00000004;
const SDL_WINDOW_RESIZABLE = 0x00000020;
const SDL_QUIT = 0x100;

const sizeOfEvent = 56;
const eventBuf = new Uint8Array(sizeOfEvent);

const sizeOfSDL_SysWMInfo = 3 + 4 + 8 * 64;
const wmInfoBuf = new Uint8Array(sizeOfSDL_SysWMInfo);

function createWindow(title: string, width: number, height: number) {
  const raw = sdl2.symbols.SDL_CreateWindow(
    asCString(title) as BufferSource,
    0x2FFF0000,
    0x2FFF0000,
    width,
    height,
    SDL_WINDOW_SHOWN | SDL_WINDOW_RESIZABLE,
  );
  if (raw === null) throw new Error("SDL_CreateWindow failed");
  return raw;
}

function createSurface(
  window: Deno.PointerValue,
  width: number,
  height: number,
): Deno.UnsafeWindowSurface {
  const wm_info = Deno.UnsafePointer.of(wmInfoBuf);
  sdl2.symbols.SDL_GetVersion(wm_info);
  const ok = sdl2.symbols.SDL_GetWindowWMInfo(window, wm_info);
  if (ok === 0) throw new Error("SDL_GetWindowWMInfo failed");

  const view = new Deno.UnsafePointerView(wm_info!);
  const subsystem = view.getUint32(4);
  
  if (BUILD_OS === "darwin") {
    const nsView = view.getPointer(4 + 4)!;
    return new Deno.UnsafeWindowSurface({
      system: "cocoa",
      windowHandle: nsView,
      displayHandle: null,
      width,
      height,
    });
  }

  if (BUILD_OS === "windows") {
    const hwnd = view.getPointer(4 + 4)!;
    const hinstance = view.getPointer(4 + 4 + 8 + 8)!;
    return new Deno.UnsafeWindowSurface({
      system: "win32",
      windowHandle: hwnd,
      displayHandle: hinstance,
      width,
      height,
    });
  }

  if (BUILD_OS === "linux") {
    const SDL_SYSWM_X11 = 2;
    const SDL_SYSWM_WAYLAND = 6;
    const display = view.getPointer(4 + 4)!; // usize
    const surface = view.getPointer(4 + 4 + 8)!; // usize
    if (subsystem === SDL_SYSWM_X11) {
      return new Deno.UnsafeWindowSurface({
        system: "x11",
        windowHandle: surface,
        displayHandle: display,
        width,
        height,
      });
    }
    if (subsystem === SDL_SYSWM_WAYLAND) {
      return new Deno.UnsafeWindowSurface({
        system: "wayland",
        windowHandle: surface,
        displayHandle: display,
        width,
        height,
      });
    }
    throw new Error("Expected SDL_SYSWM_X11 or SDL_SYSWM_WAYLAND on Linux");
  }

  throw new Error("Unsupported platform");
}
//#endregion

//#region WebGPU

console.log("Initializing SDL2 and WebGPU");
sdl2.symbols.SDL_Init(SDL_INIT_VIDEO);

const adapter = await navigator.gpu.requestAdapter();
if (!adapter) throw new Error("No WebGPU adapter found");
const device = await adapter.requestDevice();
const preferredFormat = navigator.gpu.getPreferredCanvasFormat();

const window = createWindow("Deno + R3F + WebGPU", WIDTH, HEIGHT);
const surface = createSurface(window, WIDTH, HEIGHT);
surface.resize(WIDTH, HEIGHT);

const context = surface.getContext("webgpu");
context.configure({
  device,
  format: preferredFormat,
  alphaMode: "opaque",
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
});
//#endregion

//#region R3F setup
// Canvas shim for R3F
const canvas = {
  width: WIDTH,
  height: HEIGHT,
  style: {},
  addEventListener: () => { },
  removeEventListener: () => { },
  ownerDocument: globalAny.document,
  getContext: (type: string) => {
    if (type === "webgpu") return context;
    return null;
  },
}
const root = createRoot(canvas);

// Configuration for WebGPU
await root.configure({
  gl: async (props) => {
    console.log("Initializing WebGPURenderer");
    const renderer = new THREE.WebGPURenderer({
      ...props,
      canvas,
      context,
      device,
      antialias: false,
    });
    await renderer.init();
    renderer.setSize(WIDTH, HEIGHT);
    return renderer;
  },
  size: { width: WIDTH, height: HEIGHT, top: 0, left: 0 },
  dpr: 1,
  camera: { position: [0, 0, 3], fov: 50 },
});

// Frame presenter
addAfterEffect(() => {
  try {
    surface.present();
  } catch (e) {
    console.error("Error in surface.present():", e);
    running = false;
  }
});
//#endregion

function App() {
  const meshRef = useRef<THREE.Mesh>(null!);

  useFrame((state) => {
    const t = state.clock.getElapsedTime();
    meshRef.current.rotation.x = t * 0.5;
    meshRef.current.rotation.y = t * 0.2;
    meshRef.current.position.y = Math.sin(t) * 0.1;
  });

  return (
    <>
      <color attach="background" args={[0x101010]} />
      <ambientLight intensity={Math.PI / 2} />
      <pointLight position={[10, 10, 10]} decay={0} intensity={Math.PI} />
      <mesh ref={meshRef}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0x44aa88)} />
      </mesh>
    </>
  );
}
root.render(<App />);

//Main
console.log("Entering SDL2 loop");

let running = true;
while (running) {
  try {
    const event = Deno.UnsafePointer.of(eventBuf);
    while (sdl2.symbols.SDL_PollEvent(event) === 1) {
      if ((new Deno.UnsafePointerView(event!)).getUint32() === SDL_QUIT) {
        running = false; break;
      }
    }
  } catch (e) {
    console.error("Error in SDL loop:", e);
    running = false;
  }
  await new Promise(r => setTimeout(r, 1));
}

sdl2.symbols.SDL_DestroyWindow(window);
sdl2.symbols.SDL_Quit();
Deno.exit(0);