// Server functions, declared with attribute macros. The macros lower to Solid's "use server"
// functions: the bodies only exist in the server build and run in Node (on StackBlitz, inside the
// WebContainer). The browser gets references that call them over HTTP.
import { live, server } from "solid-server-macros";

export interface Todo {
    id: number;
    text: string;
    done: boolean;
}

// A read: GET, so it can be cached and preloaded
#[server(GET)]
export async function loadTodos(): Promise<Todo[]> {
    const { readFile } = await import("node:fs/promises");
    try {
        return JSON.parse(await readFile("todos.json", "utf8"));
    } catch {
        return [
            { id: 1, text: "Fork the parser", done: true },
            { id: 2, text: "Write a jsx macro", done: true },
            { id: 3, text: "Call the server with a server function", done: false },
        ];
    }
}

// A write: POST
#[server]
export async function saveTodos(todos: Todo[]) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile("todos.json", JSON.stringify(todos, null, 2));
    return { count: todos.length };
}

#[server(GET)]
export async function serverInfo() {
    return { runtime: `Node ${process.version}`, platform: process.platform, pid: process.pid };
}

// A live source: every yield is the new value, streamed to the browser, which reconnects if needed
#[live]
export async function* serverClock() {
    while (true) {
        yield new Date().toLocaleTimeString("en-GB");
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
}
