import { For, Show, createMemo, createSignal } from "solid-js";
import { jsx } from "solid-jsx-macro";

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

interface Todo {
    id: number;
    text: string;
    done: boolean;
}

function Todos() {
    const [todos, setTodos] = createSignal<Todo[]>([
        { id: 1, text: "Fork the parser", done: true },
        { id: 2, text: "Write a jsx macro", done: false },
    ]);
    const [draft, setDraft] = createSignal("");
    const remaining = createMemo(() => todos().filter((todo) => !todo.done).length);
    let input!: HTMLInputElement;

    const add = (event: SubmitEvent) => {
        event.preventDefault();
        setTodos((list) => [...list, { id: list.length + 1, text: draft(), done: false }]);
        setDraft("");
        input.focus();
    };
    const toggle = (id: number) =>
        setTodos((list) => list.map((todo) => (todo.id === id ? { ...todo, done: !todo.done } : todo)));

    return jsx! {
        <form onSubmit={add}>
            <input ref={input} value={draft()} onInput={(e) => setDraft(e.currentTarget.value)} placeholder="New todo" />
            <button type="submit" disabled={!draft()}>Add</button>
            <ul>
                <For each={todos()}>
                    {(todo) => <li class={todo.done ? "done" : ""} onClick={() => toggle(todo.id)}>{todo.text}</li>}
                </For>
            </ul>
            <p id="remaining">{remaining()} of {todos().length} remaining</p>
        </form>
    };
}

export function App() {
    return jsx! {
        <main>
            <h1>Solid 2 with a <code>jsx!</code> macro</h1>
            <p>No Solid compiler in this build: every template below is compiled by a macro.</p>
            <Counter label="Clicks" initial={0} />
            <Todos />
        </main>
    };
}
