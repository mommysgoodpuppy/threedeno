import { tempFile } from "./util.ts";

//#region rAF polyfill
type RafCallback = (time: number) => void;
const globalAny = globalThis as unknown as {
  requestAnimationFrame?: (cb: RafCallback) => number;
  cancelAnimationFrame?: (id: number) => void;
};
if (!globalAny.requestAnimationFrame) {
  globalAny.requestAnimationFrame = (cb: RafCallback): number => {
    return setTimeout(() => cb(performance.now()), 16) as unknown as number;
  };
}
if (!globalAny.cancelAnimationFrame) {
  globalAny.cancelAnimationFrame = (id: number) => {
    clearTimeout(id as unknown as number);
  };
}
//#endregion

const BUILD_OS = Deno.build.os;

//#region SDL2 FFI
//const sdlpath = tempFile("../SDL2", import.meta.dirname!)
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
//#endregion

//#region SDL2 helpers
const enc = new TextEncoder();
function asCString(text: string): Uint8Array {
  return enc.encode(`${text}\0`);
}

const SDL_INIT_VIDEO = 0x00000020;
const SDL_WINDOW_SHOWN = 0x00000004;
const SDL_WINDOW_RESIZABLE = 0x00000020;
export const SDL_QUIT = 0x100;
export const SDL_WINDOWEVENT = 0x200;
export const SDL_WINDOWEVENT_RESIZED = 5;
export const SDL_WINDOWEVENT_SIZE_CHANGED = 6;

const sizeOfEvent = 56; // type (u32) + event union
export const eventBuf = new Uint8Array(sizeOfEvent);

const sizeOfSDL_SysWMInfo = 3 + 4 + 8 * 64;
const wmInfoBuf = new Uint8Array(sizeOfSDL_SysWMInfo);
//#endregion

function createWindow(title: string, width: number, height: number) {
  console.log("Creating SDL window", { title, width, height });
  const raw = sdl2.symbols.SDL_CreateWindow(
    asCString(title) as BufferSource,
    0x2FFF0000,
    0x2FFF0000,
    width,
    height,
    SDL_WINDOW_SHOWN | SDL_WINDOW_RESIZABLE,
  );
  if (raw === null) {
    throw new Error("SDL_CreateWindow failed");
  }
  console.log("SDL window created", raw);
  return raw;
}

function createSurface(
  window: Deno.PointerValue,
  width: number,
  height: number,
): Deno.UnsafeWindowSurface {
  console.log("Creating UnsafeWindowSurface", { width, height });
  const wm_info = Deno.UnsafePointer.of(wmInfoBuf);
  sdl2.symbols.SDL_GetVersion(wm_info);
  const ok = sdl2.symbols.SDL_GetWindowWMInfo(window, wm_info);
  if (ok === 0) {
    throw new Error("SDL_GetWindowWMInfo failed");
  }

  const view = new Deno.UnsafePointerView(wm_info!);
  const subsystem = view.getUint32(4); // u32

  if (BUILD_OS === "darwin") {
    const SDL_SYSWM_COCOA = 4;
    const nsView = view.getPointer(4 + 4)!; // usize
    if (subsystem !== SDL_SYSWM_COCOA) {
      throw new Error("Expected SDL_SYSWM_COCOA on macOS");
    }
    console.log("Using cocoa surface");
    return new Deno.UnsafeWindowSurface({
      system: "cocoa",
      windowHandle: nsView,
      displayHandle: null,
      width,
      height,
    });
  }

  if (BUILD_OS === "windows") {
    const SDL_SYSWM_WINDOWS = 1;
    const SDL_SYSWM_WINRT = 8;
    const hwnd = view.getPointer(4 + 4)!; // usize
    if (subsystem === SDL_SYSWM_WINDOWS) {
      const hinstance = view.getPointer(4 + 4 + 8 + 8)!; // usize (gap of 8 bytes)
      console.log("Using win32 surface", { hwnd, hinstance });
      return new Deno.UnsafeWindowSurface({
        system: "win32",
        windowHandle: hwnd,
        displayHandle: hinstance,
        width,
        height,
      });
    }
    if (subsystem === SDL_SYSWM_WINRT) {
      throw new Error("WinRT is not supported");
    }
    throw new Error("Expected SDL_SYSWM_WINDOWS on Windows");
  }

  if (BUILD_OS === "linux") {
    const SDL_SYSWM_X11 = 2;
    const SDL_SYSWM_WAYLAND = 6;
    const display = view.getPointer(4 + 4)!; // usize
    const surface = view.getPointer(4 + 4 + 8)!; // usize
    if (subsystem === SDL_SYSWM_X11) {
      console.log("Using x11 surface");
      return new Deno.UnsafeWindowSurface({
        system: "x11",
        windowHandle: surface,
        displayHandle: display,
        width,
        height,
      });
    }
    if (subsystem === SDL_SYSWM_WAYLAND) {
      console.log("Using wayland surface");
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

//#region Canvas shim
function makeCanvas(
  surface: Deno.UnsafeWindowSurface,
  width: number,
  height: number,
) {
  console.log("Creating canvas shim", { width, height });
  const context = surface.getContext("webgpu");
  const canvas = {
    width,
    height,
    getContext(type: "webgpu") {
      if (type !== "webgpu") {
        return null;
      }
      console.log("Canvas.getContext('webgpu')");
      return context;
    },
    requestAnimationFrame: globalAny.requestAnimationFrame,
    cancelAnimationFrame: globalAny.cancelAnimationFrame,
    addEventListener() {},
    removeEventListener() {},
    style: {},
  } as unknown as {
    width: number;
    height: number;
    getContext: (type: "webgpu") => GPUCanvasContext | null;
    requestAnimationFrame?: (cb: RafCallback) => number;
    cancelAnimationFrame?: (id: number) => void;
  };

  return { canvas, context };
}
//#endregion

export type ResizeCallback = (width: number, height: number) => void;

export async function initSDL(
  width: number,
  height: number,
  options?: {
    handleEvents?: (event: Deno.UnsafePointerView) => void;
    onResize?: ResizeCallback;
  },
) {
  const handleEvents = options?.handleEvents;
  const onResize = options?.onResize;
  //#region WebGPU init
  console.log("Initializing SDL2 video subsystem");
  const initResult = sdl2.symbols.SDL_Init(SDL_INIT_VIDEO);
  if (initResult !== 0) {
    throw new Error("SDL_Init failed");
  }
  console.log("SDL2 initialized");

  console.log("Requesting WebGPU adapter");
  const adapter = await navigator.gpu.requestAdapter();

  if (!adapter) {
    throw new Error("No appropriate GPUAdapter found");
  }
  const preferredFormat = navigator.gpu.getPreferredCanvasFormat();
  console.log("Requesting WebGPU device");
  const device = await adapter.requestDevice();
  console.log("WebGPU device ready");

  const window = createWindow("Deno + SDL2 + WebGPU", width, height);
  console.log("Window handle", window);
  const surface = createSurface(window, width, height);
  console.log("UnsafeWindowSurface created");
  const { canvas, context: canvasContext } = makeCanvas(surface, width, height);
  console.log("Canvas shim created");
  console.log("Resizing WebGPU surface");
  surface.resize(width, height);
  console.log("Configuring WebGPU canvas context");
  canvasContext.configure({
    device,
    format: preferredFormat,
    alphaMode: "opaque",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  console.log("WebGPU canvas configured", { format: preferredFormat });
  //#endregion

  return {
    sdl2,
    window,
    surface,
    canvas,
    canvasContext,
    device,
    preferredFormat,
    resizeSurface: (newWidth: number, newHeight: number) => {
      canvas.width = newWidth;
      canvas.height = newHeight;
      surface.resize(newWidth, newHeight);
      canvasContext.configure({
        device,
        format: preferredFormat,
        alphaMode: "opaque",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
    },
    pollEvents: () => {
      const event = Deno.UnsafePointer.of(eventBuf);
      while (sdl2.symbols.SDL_PollEvent(event) === 1) {
        const view = new Deno.UnsafePointerView(event!);
        const type = view.getUint32();
        if (handleEvents) {
          handleEvents(view);
        }
        // Handle window resize events
        // SDL_WindowEvent layout: type(4) + timestamp(4) + windowID(4) + event(1) + padding(3) + data1(4) + data2(4)
        if (type === SDL_WINDOWEVENT && onResize) {
          const windowEventType = view.getUint8(12); // event field at offset 12
          // Only handle SIZE_CHANGED (covers all cases, avoids duplicate with RESIZED)
          if (windowEventType === SDL_WINDOWEVENT_SIZE_CHANGED) {
            const newWidth = view.getInt32(16); // data1 at offset 16
            const newHeight = view.getInt32(20); // data2 at offset 20
            onResize(newWidth, newHeight);
          }
        }
        if (type === SDL_QUIT) {
          return false;
        }
      }
      return true;
    },
    cleanup: () => {
      sdl2.symbols.SDL_DestroyWindow(window);
      sdl2.symbols.SDL_Quit();
    },
  };
}
