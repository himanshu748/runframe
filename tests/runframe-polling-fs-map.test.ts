import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test"
import type { useRunFrameStore as RunFrameStore } from "../lib/components/RunFrameWithApi/store"
import type {
  File,
  FileContent,
  FilePath,
  RunFrameEvent,
} from "../lib/components/RunFrameWithApi/types"

let useRunFrameStore: typeof RunFrameStore
const originalSetTimeout = globalThis.setTimeout
const originalFetch = globalThis.fetch
let pollFinished: ReturnType<typeof Promise.withResolvers<void>>
let pendingResponse: ReturnType<typeof Promise.withResolvers<Response>>
let pendingFilePath: FilePath | null

beforeAll(async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const needsWindow = typeof window === "undefined"
  if (needsWindow) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    })
  }
  try {
    ;({ useRunFrameStore } = await import(
      "../lib/components/RunFrameWithApi/store"
    ))
  } finally {
    if (needsWindow) {
      if (originalWindow) {
        Object.defineProperty(globalThis, "window", originalWindow)
      } else {
        Reflect.deleteProperty(globalThis, "window")
      }
    }
  }
})

beforeEach(() => {
  useRunFrameStore.setState(useRunFrameStore.getInitialState(), true)
  pollFinished = Promise.withResolvers<void>()
  pendingResponse = Promise.withResolvers<Response>()
  pendingFilePath = null
  spyOn(globalThis, "setTimeout").mockImplementation(
    Object.assign((...args: Parameters<typeof setTimeout>) => {
      const timer = originalSetTimeout(...args)
      if (args[1] === 1000) {
        clearTimeout(timer)
        pollFinished.resolve()
      }
      return timer
    }, originalSetTimeout),
  )
})

afterEach(async () => {
  const wasPolling = useRunFrameStore.getState().isPolling
  useRunFrameStore.getState().stopPolling()
  pendingResponse.resolve(
    pendingFilePath
      ? fileResponse(pendingFilePath, "server content")
      : Response.json({ event_list: [] }),
  )
  if (wasPolling) await pollFinished.promise
  spyOn(globalThis, "fetch").mockRestore()
  spyOn(globalThis, "setTimeout").mockRestore()
  useRunFrameStore.setState(useRunFrameStore.getInitialState(), true)
})

function fileResponse(file_path: FilePath, text_content: FileContent) {
  return Response.json({
    file: { file_id: file_path, file_path, text_content } satisfies File,
  })
}

function mockFetch(
  implementation: (
    ...args: Parameters<typeof fetch>
  ) => ReturnType<typeof fetch>,
) {
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(implementation, originalFetch),
  )
}

function fileEvent(
  file_path: FilePath,
  event_type: "FILE_UPDATED" | "FILE_DELETED" = "FILE_UPDATED",
): RunFrameEvent {
  return {
    event_id: `${event_type}:${file_path}`,
    event_type,
    file_path,
    created_at: "2026-10-07T12:00:00.000Z",
  }
}

function startDeferredPoll(pauseAt: "events" | "file") {
  const requestStarted = Promise.withResolvers<void>()
  const events = [fileEvent("a.tsx")]
  mockFetch(async (input, init) => {
    const url = new URL(String(input), "http://localhost")
    if (url.pathname.endsWith("/events/list")) {
      if (pauseAt === "events") {
        requestStarted.resolve()
        return pendingResponse.promise
      }
      return Response.json({ event_list: events })
    }
    if (url.pathname.endsWith("/files/get")) {
      const file_path = url.searchParams.get("file_path")!
      if (pauseAt === "file" && file_path === "a.tsx") {
        pendingFilePath = file_path
        requestStarted.resolve()
        return pendingResponse.promise
      }
      return fileResponse(file_path, "server a")
    }
    if (url.pathname.endsWith("/files/upsert")) {
      const { file_path, text_content } = JSON.parse(String(init?.body))
      return fileResponse(file_path, text_content)
    }
    throw new Error(`Unexpected request: ${input}`)
  })
  useRunFrameStore.getState().startPolling()
  return {
    requestStarted: requestStarted.promise,
    finish: async () => {
      pendingResponse.resolve(
        pauseAt === "events"
          ? Response.json({ event_list: events })
          : fileResponse("a.tsx", "server a"),
      )
      await pollFinished.promise
      expect(useRunFrameStore.getState().error).toBeNull()
      expect(useRunFrameStore.getState().fsMap.get("a.tsx")).toBe("server a")
    },
  }
}

describe("polling preserves unrelated local file changes", () => {
  for (const pauseAt of ["events", "file"] as const) {
    test(`preserves a completed upsert while awaiting ${pauseAt}`, async () => {
      useRunFrameStore.setState({ fsMap: new Map([["b.tsx", "old b"]]) })
      const poll = startDeferredPoll(pauseAt)
      await poll.requestStarted

      await useRunFrameStore.getState().upsertFile("b.tsx", "local b")
      expect(useRunFrameStore.getState().fsMap.get("b.tsx")).toBe("local b")

      await poll.finish()
      expect(useRunFrameStore.getState().fsMap.get("b.tsx")).toBe("local b")
    })

    test(`preserves a newly created file while awaiting ${pauseAt}`, async () => {
      const poll = startDeferredPoll(pauseAt)
      await poll.requestStarted

      await useRunFrameStore.getState().upsertFile("b.tsx", "new b")
      expect(useRunFrameStore.getState().fsMap.get("b.tsx")).toBe("new b")

      await poll.finish()
      expect(useRunFrameStore.getState().fsMap.get("b.tsx")).toBe("new b")
    })

    test(`preserves a local deletion while awaiting ${pauseAt}`, async () => {
      useRunFrameStore.setState({ fsMap: new Map([["b.tsx", "old b"]]) })
      const poll = startDeferredPoll(pauseAt)
      await poll.requestStarted

      // There is no delete action; remove the file through the public store API.
      useRunFrameStore.setState((state) => {
        const fsMap = new Map(state.fsMap)
        fsMap.delete("b.tsx")
        return { fsMap }
      })
      expect(useRunFrameStore.getState().fsMap.has("b.tsx")).toBe(false)

      await poll.finish()
      expect(useRunFrameStore.getState().fsMap.has("b.tsx")).toBe(false)
    })
  }
})

test("polling still applies dynamic files, static assets, and deletions", async () => {
  useRunFrameStore.setState({
    fsMap: new Map([
      ["deleted.tsx", "old content"],
      ["untouched.tsx", "untouched content"],
    ]),
  })
  const events = [
    fileEvent("a.tsx"),
    fileEvent("model.step"),
    fileEvent("deleted.tsx", "FILE_DELETED"),
  ]
  mockFetch(async (input) => {
    const url = new URL(String(input), "http://localhost")
    if (url.pathname.endsWith("/events/list")) {
      return Response.json({ event_list: events })
    }
    return fileResponse(url.searchParams.get("file_path")!, "server content")
  })

  useRunFrameStore.getState().startPolling()
  await pollFinished.promise

  expect(useRunFrameStore.getState().error).toBeNull()
  expect(useRunFrameStore.getState().fsMap).toEqual(
    new Map([
      ["untouched.tsx", "untouched content"],
      ["a.tsx", "server content"],
      ["model.step", "__STATIC_ASSET__"],
    ]),
  )
  expect(useRunFrameStore.getState().recentlySavedFiles).toEqual(["a.tsx"])
})

test("an empty event batch leaves the file map unchanged", async () => {
  const fsMap = new Map<FilePath, FileContent>([["b.tsx", "local b"]])
  useRunFrameStore.setState({ fsMap })
  spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ event_list: [] }),
  )

  useRunFrameStore.getState().startPolling()
  await pollFinished.promise

  expect(useRunFrameStore.getState().error).toBeNull()
  expect(useRunFrameStore.getState().fsMap).toBe(fsMap)
})
