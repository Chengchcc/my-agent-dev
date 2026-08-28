"use client";

import { loader } from "@monaco-editor/react";

loader.config({
  paths: { vs: "/monaco/vs" },
});

export { loader };
