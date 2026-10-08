import { render } from "@solidjs/web";
import { jsx } from "solid-jsx-macro";

import { App } from "./App.ts";

render(() => jsx! { <App /> }, document.getElementById("app")!);
