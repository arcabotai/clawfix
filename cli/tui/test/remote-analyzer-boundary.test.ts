import { afterEach, describe, expect, test } from "bun:test"

import { createRemoteAnalyzer } from "../src/remote-analyzer"

const originalApi = process.env.CLAWFIX_API
const originalToken = process.env.CLAWFIX_API_TOKEN

afterEach(() => {
  if (originalApi == null) delete process.env.CLAWFIX_API
  else process.env.CLAWFIX_API = originalApi
  if (originalToken == null) delete process.env.CLAWFIX_API_TOKEN
  else process.env.CLAWFIX_API_TOKEN = originalToken
})

function fakeSession() {
  return {
    getState() {
      return {
        diagnostic: { system: { os: "linux" } },
        issues: [],
        findings: [],
      }
    },
  }
}

describe("TUI remote analyzer network boundary", () => {
  test("refuses a direct send without explicit consent and performs no fetch", async () => {
    const requests: unknown[] = []
    const analyzer = createRemoteAnalyzer({
      session: fakeSession() as any,
      baseUrl: "https://example.test",
      fetchImpl: (async (...args: unknown[]) => {
        requests.push(args)
        throw new Error("must not fetch")
      }) as any,
    })

    const events: any[] = []
    for await (const event of analyzer.send({ message: "help", consentGranted: false })) {
      events.push(event)
    }

    expect(requests).toHaveLength(0)
    expect(events).toEqual([{
      type: "agent.error",
      error: "Remote analysis requires explicit consent.",
      fatal: true,
    }])
  })

  test("uses the documented CLAWFIX_API and CLAWFIX_API_TOKEN variables", async () => {
    process.env.CLAWFIX_API = "https://self-hosted.example/path"
    process.env.CLAWFIX_API_TOKEN = "test-token"
    const requests: Array<{ url: string; init: RequestInit }> = []
    const analyzer = createRemoteAnalyzer({
      session: { getState: () => ({ diagnostic: null, issues: [], findings: [] }) } as any,
      fetchImpl: (async (url: string, init: RequestInit) => {
        requests.push({ url, init })
        return new Response("event: agent.done\ndata: {}\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      }) as any,
    })

    expect(analyzer.baseUrl).toBe("https://self-hosted.example")
    expect(analyzer.endpointUrl).toBe("https://self-hosted.example/api/v2/agent/messages")
    const secretMessage = "token=opaque-message-secret Authorization: Bearer abcdefghijklmnop"
    const preview = analyzer.describeOutbound(secretMessage)
    expect(JSON.stringify(preview)).not.toContain("opaque-message-secret")
    expect(JSON.stringify(preview)).not.toContain("abcdefghijklmnop")

    const events = []
    for await (const event of analyzer.send({ message: secretMessage, consentGranted: true })) {
      events.push(event)
    }
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe(analyzer.endpointUrl)
    expect(String(requests[0]!.init.body)).not.toContain("opaque-message-secret")
    expect(String(requests[0]!.init.body)).not.toContain("abcdefghijklmnop")
    expect(requests[0]!.init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer test-token",
    })
    expect(events).toEqual([{ type: "agent.done" }])
  })

  test("times out a server that never responds", async () => {
    const analyzer = createRemoteAnalyzer({
      session: { getState: () => ({ diagnostic: null, issues: [], findings: [] }) } as any,
      baseUrl: "https://example.test",
      timeoutMs: 20,
      fetchImpl: (async (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      })) as any,
    })

    const events: any[] = []
    for await (const event of analyzer.send({ message: "help", consentGranted: true })) events.push(event)
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe("agent.error")
    expect(events[0]?.error).toContain("request timed out")
  })

  test("rejects an oversized incomplete SSE frame", async () => {
    const analyzer = createRemoteAnalyzer({
      session: { getState: () => ({ diagnostic: null, issues: [], findings: [] }) } as any,
      baseUrl: "https://example.test",
      fetchImpl: (async () => new Response(`event: assistant.delta\ndata: ${"x".repeat(300_000)}`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })) as any,
    })

    const events: any[] = []
    for await (const event of analyzer.send({ message: "help", consentGranted: true })) events.push(event)
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe("agent.error")
    expect(events[0]?.error).toContain("buffer limit")
  })
})
