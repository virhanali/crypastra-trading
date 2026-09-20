import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";

const target = document.getElementById("app");
if (target === null) {
  throw new Error("Elemen #app tidak ditemukan");
}

export default mount(App, { target });
