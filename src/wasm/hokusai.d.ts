/* tslint:disable */
/* eslint-disable */

export class HokusaiBrush {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Parse a `.myb` JSON document.
     */
    constructor(myb_json: string);
    /**
     * Read the brush's designed radius (its `radius_logarithmic` base
     * value). Useful for UIs that want to offset from the natural size
     * rather than override it outright.
     */
    radiusLog(): number;
    /**
     * Override the HSV base colour (each channel in [0, 1]).
     */
    setColorHsv(h: number, s: number, v: number): void;
    /**
     * Override the base radius (libmypaint's `radius_logarithmic`, log2 px).
     */
    setRadiusLog(log2_radius: number): void;
}

/**
 * A drawable canvas. Holds the tiled surface, an active [`BrushState`],
 * and the RGBA8 output buffer reused across `pixels()` calls.
 */
export class HokusaiCanvas {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Drop all painted tiles and reset stroke state. Cheaper and safer than
     * reconstructing the canvas object on the JS side.
     */
    clear(): void;
    /**
     * Byte length of one dirty-tile header entry. JS needs this to parse
     * [`Self::drain_dirty`] without hard-coding the layout.
     */
    dirtyEntryBytes(): number;
    /**
     * Take the tiles painted since the previous call, as straight-alpha sRGB
     * RGBA8, clipped to the canvas.
     *
     * Buffer layout, all little-endian:
     * ```text
     * u32 count
     * count × 24 bytes:
     *     i32 tx, i32 ty            tile index (can be any tile of w×h/64)
     *     u32 x0, u32 y0, u32 x1, u32 y1
     *                               world-space pixel rect, x1/y1 exclusive,
     *                               already clipped to [0,width)×[0,height)
     * then, in the same order, the pixels of each entry:
     *     (x1-x0) * (y1-y0) * 4 bytes, row-major, straight alpha
     * ```
     * Payload offsets are cumulative over the header, so JS can slice it
     * without knowing the tile size.
     */
    drainDirty(): Uint8Array;
    /**
     * Flush `slow_tracking` lag so the stroke's trailing pixels are painted.
     * Call on pointer-up *before* resetting.
     */
    finishStroke(brush: HokusaiBrush): boolean;
    /**
     * Refresh the whole-canvas buffer without copying it to JS. Call
     * `flush_pixels()` first, then read through `pixelsPtr()`/`pixelsLen()`.
     */
    flush_pixels(): void;
    /**
     * True when no tile has been painted since the last `clear()`.
     */
    isEmpty(): boolean;
    constructor(width: number, height: number);
    pixelsLen(): number;
    pixelsPtr(): number;
    /**
     * Return the canvas as RGBA8 in sRGB, composited over white.
     *
     * Whole-canvas and alpha-free: kept for API compatibility, not for
     * per-frame layer updates. Use [`Self::drain_dirty`] for that.
     */
    pixels(): Uint8Array;
    /**
     * End the current stroke so the next `strokeTo` starts fresh.
     */
    resetStroke(): void;
    /**
     * Feed one pointer event. `dtime` is seconds since the previous call.
     *
     * `xtilt` / `ytilt` are pen tilt in [-1, 1], matching libmypaint's
     * convention. Pass 0 for devices that don't report tilt.
     *
     * Returns whether any dab was painted. Tiles touched by this event are
     * queued for the next [`Self::drain_dirty`].
     */
    strokeTo(brush: HokusaiBrush, x: number, y: number, pressure: number, xtilt: number, ytilt: number, dtime: number): boolean;
    /**
     * hokusai's tile edge in pixels (64).
     */
    tileSize(): number;
    readonly height: number;
    readonly width: number;
}

export function start(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_hokusaibrush_free: (a: number, b: number) => void;
    readonly __wbg_hokusaicanvas_free: (a: number, b: number) => void;
    readonly hokusaibrush_new: (a: number, b: number) => [number, number, number];
    readonly hokusaibrush_radiusLog: (a: number) => number;
    readonly hokusaibrush_setColorHsv: (a: number, b: number, c: number, d: number) => void;
    readonly hokusaibrush_setRadiusLog: (a: number, b: number) => void;
    readonly hokusaicanvas_clear: (a: number) => void;
    readonly hokusaicanvas_dirtyEntryBytes: (a: number) => number;
    readonly hokusaicanvas_drainDirty: (a: number) => [number, number];
    readonly hokusaicanvas_finishStroke: (a: number, b: number) => number;
    readonly hokusaicanvas_flush_pixels: (a: number) => void;
    readonly hokusaicanvas_height: (a: number) => number;
    readonly hokusaicanvas_isEmpty: (a: number) => number;
    readonly hokusaicanvas_new: (a: number, b: number) => number;
    readonly hokusaicanvas_pixels: (a: number) => [number, number];
    readonly hokusaicanvas_pixelsLen: (a: number) => number;
    readonly hokusaicanvas_pixelsPtr: (a: number) => number;
    readonly hokusaicanvas_resetStroke: (a: number) => void;
    readonly hokusaicanvas_strokeTo: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
    readonly hokusaicanvas_tileSize: (a: number) => number;
    readonly hokusaicanvas_width: (a: number) => number;
    readonly start: () => void;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
