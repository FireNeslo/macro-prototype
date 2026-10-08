import { Errored, For, Loading, Show, action, createMemo, createOptimistic, createSignal, refresh } from "solid-js";
import { jsx } from "solid-jsx-macro";

import { type Todo, loadTodos, saveTodos, serverClock, serverInfo } from "./api.ts";

function Counter(props: { label: string; initial: number }) {
    const [count, setCount] = createSignal(props.initial);
    return jsx! {
        <section class={count() >= 5 ? "counter hot" : "counter"}>
            <h2>{props.label}: <output>{count()}</output></h2>
            <button id="increment" onClick={() => setCount((c) => c + 1)} disabled={count() >= 10}>+1</button>
            <button id="reset" onClick={() => setCount(props.initial)}>reset</button>
            <Show when={count() >= 10} fallback={<small>{10 - count()} to go</small>}>
                <strong>maximum reached</strong>
            </Show>
        </section>
    };
}

// Todos come from a GET server function, and are saved by a POST server function inside an
// action: the change shows at once (optimistic), then the list is re-fetched from the server.
function Todos() {
    const serverTodos = createMemo(() => loadTodos());
    const [todos, setTodos] = createOptimistic(() => serverTodos());
    const [draft, setDraft] = createSignal("");
    const [status, setStatus] = createSignal("Loaded from the server");
    const remaining = createMemo(() => todos().filter((todo) => !todo.done).length);
    let input!: HTMLInputElement;

    const update = action(async function* (list: Todo[]) {
        setTodos(list);
        const { count } = await saveTodos(list);
        yield;
        setStatus(`Saved ${count} todos to todos.json on the server`);
        refresh(serverTodos);
    });
    const add = (event: SubmitEvent) => {
        event.preventDefault();
        update([...todos(), { id: Date.now(), text: draft(), done: false }]);
        setDraft("");
        input.focus();
    };
    const toggle = (id: number) => update(todos().map((todo) => (todo.id === id ? { ...todo, done: !todo.done } : todo)));

    return jsx! {
        <form onSubmit={add}>
            <input ref={input} value={draft()} onInput={(e) => setDraft(e.currentTarget.value)} placeholder="New todo" />
            <button type="submit" disabled={!draft()}>Add</button>
            <ul>
                <For each={todos()} keyed={(todo) => todo.id}>
                    {(todo) => <li class={todo().done ? "done" : ""} onClick={() => toggle(todo().id)}>{todo().text}</li>}
                </For>
            </ul>
            <p id="remaining">{remaining()} of {todos().length} remaining</p>
            <p id="status"><small>{status()}</small></p>
        </form>
    };
}

// A GET server function, and a live one: each value the server yields replaces the last
function ServerInfo() {
    const info = createMemo(() => serverInfo());
    const time = createMemo(() => serverClock());
    return jsx! {
        <p id="server">
            Answered by <code id="runtime">{info().runtime} on {info().platform}, process {info().pid}</code>.
            Server time, streamed live: <code id="clock">{time()}</code>
        </p>
    };
}

export function App() {
    return jsx! {
        <main>
            <h1>Solid 2 with a <code>jsx!</code> macro</h1>
            <p>Every template below is compiled by a macro: the app has no JSX for the Solid compiler.</p>
            <Counter label="Clicks" initial={0} />
            <h2>Server functions</h2>
            <p>The panels below use server functions declared with attribute macros in <code>src/api.ts</code>. The macros lower to the server functions of Solid 2, which its Vite plugin compiles: the code runs on the server, and the browser only gets references to it.</p>
            <Errored fallback={<p id="offline">Server functions need the dev server.</p>}>
                <Loading fallback={<p>Asking the server</p>}>
                    <ServerInfo />
                </Loading>
                <Loading fallback={<p>Loading todos from the server</p>}>
                    <Todos />
                </Loading>
            </Errored>
        </main>
    };
}
