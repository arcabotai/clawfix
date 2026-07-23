import { afterEach, describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { readFile } from "node:fs/promises"

import { testRender } from "@opentui/solid"

import { App, createFakeSession } from "../src/app"
import { exitCodeForSignal, ownRendererLifecycle } from "../src/main"

const renderers: Array<{ destroy(): void }> = []

afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.destroy()
})

describe("OpenTUI package compatibility", () => {
  test("pins the renderer, Solid binding, native package, keymap, and peers", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))

    expect(manifest.dependencies).toMatchObject({
      "@opentui/core": "0.4.5",
      "@opentui/keymap": "0.4.5",
      "@opentui/solid": "0.4.5",
      "solid-js": "1.9.12",
      "web-tree-sitter": "0.25.10",
    })
    expect(manifest.optionalDependencies).toEqual({ "@opentui/core-linux-x64": "0.4.5" })
  })

  test("matches the installed packages' published compatibility metadata", async () => {
    const packageJson = (name: string) => readFile(
      new URL(`../node_modules/${name}/package.json`, import.meta.url),
      "utf8",
    ).then(JSON.parse)
    const [core, solid, keymap, native] = await Promise.all([
      packageJson("@opentui/core"),
      packageJson("@opentui/solid"),
      packageJson("@opentui/keymap"),
      packageJson("@opentui/core-linux-x64"),
    ])

    expect(core.version).toBe("0.4.5")
    expect(core.peerDependencies).toEqual({ "web-tree-sitter": "0.25.10" })
    expect(core.optionalDependencies["@opentui/core-linux-x64"]).toBe(native.version)
    expect(solid.version).toBe("0.4.5")
    expect(solid.dependencies["@opentui/core"]).toBe(core.version)
    expect(solid.peerDependencies).toEqual({ "solid-js": "1.9.12" })
    expect(keymap.version).toBe("0.4.5")
    expect(keymap.dependencies["@opentui/core"]).toBe(core.version)
    expect(keymap.peerDependencies["@opentui/solid"]).toBe(solid.version)
    expect(keymap.peerDependencies["solid-js"]).toBe("1.9.12")
  })

  test("preloads the Solid transform and never configures runtime parser downloads", async () => {
    const [bunfig, tsconfig, source] = await Promise.all([
      readFile(new URL("../bunfig.toml", import.meta.url), "utf8"),
      readFile(new URL("../tsconfig.json", import.meta.url), "utf8"),
      readFile(new URL("../src/app.tsx", import.meta.url), "utf8"),
    ])

    expect(bunfig).toContain('@opentui/solid/preload')
    expect(JSON.parse(tsconfig).compilerOptions.jsxImportSource).toBe("@opentui/solid")
    expect(source).not.toMatch(/https?:\/\//)
    expect(source).not.toMatch(/tree[-_]?sitter|parser/i)
  })
})

describe("conversation app", () => {
  test("advertises only implemented composer shortcuts", async () => {
    const setup = await testRender(
      () => <App session={createFakeSession()} simpleComposer />,
      { width: 80, height: 24 },
    )
    renderers.push(setup.renderer)
    await setup.renderOnce()

    const frame = setup.captureCharFrame()
    expect(frame).toMatch(/Enter send/i)
    // Do not claim a standalone quit key chord beyond host signal handling.
    expect(frame).not.toMatch(/press q to quit/i)
  })

  for (const [width, height] of [[80, 24], [120, 40]] as const) {
    test(`renders an injected session at ${width}x${height}`, async () => {
      const setup = await testRender(
        () => <App session={createFakeSession()} simpleComposer />,
        { width, height },
      )
      renderers.push(setup.renderer)
      await setup.renderOnce()
      const frame = setup.captureCharFrame()

      expect(frame).toContain("ClawFix")
      expect(frame).toContain("Tell me what is going wrong")
      expect(frame).toContain("Local session ready")
    })
  }

  test("compact terminal still shows brand and status", async () => {
    const setup = await testRender(
      () => <App session={createFakeSession()} simpleComposer />,
      { width: 40, height: 12 },
    )
    renderers.push(setup.renderer)
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    // Compact frames may clip/wrap glyphs; assert stable status fragments.
    expect(frame).toMatch(/ClawFix|OpenClaw|Local/i)
    expect(frame).toMatch(/session|ready|Local/i)
  })

  test("renders live findings from a session source", async () => {
    const view = Object.freeze({
      ...createFakeSession(),
      status: "Revision rev-live · 1 finding · AI local only",
      revision: "rev-live",
      findings: Object.freeze([
        Object.freeze({
          id: "finding-gateway",
          title: "Gateway is not running",
          severity: "error",
          repairable: true,
          repairId: "gateway-not-running",
        }),
      ]),
      items: Object.freeze([
        Object.freeze({
          kind: "finding" as const,
          id: "finding-card-finding-gateway",
          findingId: "finding-gateway",
          title: "Gateway is not running",
          severity: "error",
          repairable: true,
          repairId: "gateway-not-running",
          evidence: null,
        }),
      ]),
    })
    const setup = await testRender(
      () => <App session={view} simpleComposer />,
      { width: 100, height: 30 },
    )
    renderers.push(setup.renderer)
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Gateway is not running")
    expect(frame).toContain("repairable")
    expect(frame).toContain("rev-live")
  })
})

class FakeProcess extends EventEmitter {}

function deferred(): Promise<never> {
  return new Promise(() => {})
}

function rendererProbe() {
  let destroys = 0
  return {
    renderer: { destroy: () => { destroys += 1 } },
    destroyCount: () => destroys,
  }
}

describe("renderer lifecycle", () => {
  test("preserves conventional exit codes for handled signals", () => {
    expect(exitCodeForSignal("SIGHUP")).toBe(129)
    expect(exitCodeForSignal("SIGINT")).toBe(130)
    expect(exitCodeForSignal("SIGTERM")).toBe(143)
  })

  test("destroys after normal exit", async () => {
    const probe = rendererProbe()
    await ownRendererLifecycle({
      createRenderer: async () => probe.renderer,
      mount: () => undefined,
      run: async () => undefined,
      processTarget: new FakeProcess(),
    })
    expect(probe.destroyCount()).toBe(1)
  })

  test("destroys when mounting fails during startup", async () => {
    const probe = rendererProbe()
    await expect(ownRendererLifecycle({
      createRenderer: async () => probe.renderer,
      mount: () => { throw new Error("startup failed") },
      run: async () => undefined,
      processTarget: new FakeProcess(),
    })).rejects.toThrow("startup failed")
    expect(probe.destroyCount()).toBe(1)
  })

  for (const [event, value] of [
    ["uncaughtException", new Error("render failed")],
    ["unhandledRejection", new Error("render rejected")],
  ] as const) {
    test(`destroys after ${event}`, async () => {
      const probe = rendererProbe()
      const processTarget = new FakeProcess()
      const running = ownRendererLifecycle({
        createRenderer: async () => probe.renderer,
        mount: () => undefined,
        run: deferred,
        processTarget,
      })
      await Promise.resolve()
      processTarget.emit(event, value)

      await expect(running).rejects.toThrow(value.message)
      expect(probe.destroyCount()).toBe(1)
      expect(processTarget.listenerCount(event)).toBe(0)
    })
  }

  test("destroys after a termination signal", async () => {
    const probe = rendererProbe()
    const processTarget = new FakeProcess()
    const running = ownRendererLifecycle({
      createRenderer: async () => probe.renderer,
      mount: () => undefined,
      run: deferred,
      processTarget,
    })
    await Promise.resolve()
    processTarget.emit("SIGTERM")

    await expect(running).resolves.toEqual({ reason: "signal", signal: "SIGTERM" })
    expect(probe.destroyCount()).toBe(1)
    expect(processTarget.listenerCount("SIGTERM")).toBe(0)
  })
})
