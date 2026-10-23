import { describe, it, expect, vi, beforeAll } from 'vitest';

// PIN (wave 5): what every LLM-output stripper does TODAY, one row per input, one column per
// caller. Written before the five strippers were folded into shared/clean-llm-output.ts, so
// the fold must keep every cell green without editing this table. Where callers disagree
// (case flags, capability-regex shape, which tags each knows, trim vs trimEnd), the table
// records each caller's own output on purpose. Do not "fix" a cell here; a behavior change
// belongs to waves 7/10 and must show up as an edited row there.

// stream-reply.ts pulls the engine client, the job watcher and telemetry at import time
// (intervals, HTTP clients); none of them run in these rows.
vi.mock('../../src/gateway/3-ask-engine/engine-client.js', () => ({ capabilitiesClient: {} }));
vi.mock('../../src/gateway/3-ask-engine/job-watcher.js', () => ({ jobMonitor: {} }));
vi.mock('../../src/gateway/telemetry.js', () => ({
  telemetry: new Proxy({}, { get: () => () => {} }),
}));

import { stripCapabilityXML } from '../../src/shared/clean-llm-output.js';
import { cleanCapabilityTags } from '../../src/gateway/4-reply/stream-reply.js';
import { sanitizeAssistantMessage } from '../../src/engine/3-context/sources/transcript.js';
import { stripCapabilityTags } from '../../src/engine/memory/recall.js';

type Coordinator = typeof import('../../src/engine/4-generate/generate-reply.js').llmResponseCoordinator;
let coordinator: Coordinator;
beforeAll(async () => {
  coordinator = (await import('../../src/engine/4-generate/generate-reply.js')).llmResponseCoordinator;
  // stripCapabilityXML reports every strip on console.error; keep the run quiet.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

interface Row {
  name: string;
  input: string;
  /** shared stripCapabilityXML: push-worker's last-line filter before channel.send */
  outbound: string;
  /** stream-reply cleanCapabilityTags: every streamed edit and the final reply */
  reply: string;
  /** transcript sanitizeAssistantMessage: stored assistant turns replayed as history */
  history: string;
  /** recall stripCapabilityTags: memory text before it enters the prompt */
  recall: string;
  /** generate-reply stripThinkingTags: every tool-loop response */
  generate: string;
  /** generate-reply extractLoopDecision(...).response: the <wants_loop> strip */
  loopStrip: string;
}

const ROWS: Row[] = [
  {
    name: "plain text, outer whitespace",
    input: "  just text, nothing to strip  \n",
    outbound: "just text, nothing to strip",
    reply: "just text, nothing to strip",
    history: "just text, nothing to strip",
    recall: "just text, nothing to strip",
    generate: "  just text, nothing to strip",
    loopStrip: "just text, nothing to strip",
  },
  {
    name: "self-closing capability",
    input: "Sure. <capability name=\"web\" action=\"search\" query=\"x\"/> Done.",
    outbound: "Sure.  Done.",
    reply: "Sure.  Done.",
    history: "Sure.  Done.",
    recall: "Sure. Done.",
    generate: "Sure. <capability name=\"web\" action=\"search\" query=\"x\"/> Done.",
    loopStrip: "Sure. <capability name=\"web\" action=\"search\" query=\"x\"/> Done.",
  },
  {
    name: "paired capability",
    input: "Hi <capability name=\"memory\" action=\"remember\">likes tea</capability> there",
    outbound: "Hi  there",
    reply: "Hi  there",
    history: "Hi  there",
    recall: "Hi there",
    generate: "Hi <capability name=\"memory\" action=\"remember\">likes tea</capability> there",
    loopStrip: "Hi <capability name=\"memory\" action=\"remember\">likes tea</capability> there",
  },
  {
    name: "upper-case CAPABILITY tag",
    input: "A <CAPABILITY name=\"x\"/> B",
    outbound: "A  B",
    reply: "A <CAPABILITY name=\"x\"/> B",
    history: "A  B",
    recall: "A <CAPABILITY name=\"x\"/> B",
    generate: "A <CAPABILITY name=\"x\"/> B",
    loopStrip: "A <CAPABILITY name=\"x\"/> B",
  },
  {
    name: "attribute containing >",
    input: "<capability name=\"x\" data=\"a>b\"/> tail",
    outbound: "<capability name=\"x\" data=\"a>b\"/> tail",
    reply: "<capability name=\"x\" data=\"a>b\"/> tail",
    history: "<capability name=\"x\" data=\"a>b\"/> tail",
    recall: "tail",
    generate: "<capability name=\"x\" data=\"a>b\"/> tail",
    loopStrip: "<capability name=\"x\" data=\"a>b\"/> tail",
  },
  {
    name: "self-closing then paired (order)",
    input: "<capability a=\"1\"/> keep <capability b=\"2\">body</capability> end",
    outbound: "end",
    reply: "keep  end",
    history: "keep  end",
    recall: "keep end",
    generate: "<capability a=\"1\"/> keep <capability b=\"2\">body</capability> end",
    loopStrip: "<capability a=\"1\"/> keep <capability b=\"2\">body</capability> end",
  },
  {
    name: "multiline paired capability",
    input: "Start\n<capability name=\"tts\" action=\"sing\">\nla la\n</capability>\nEnd",
    outbound: "Start\n\nEnd",
    reply: "Start\n\nEnd",
    history: "Start\n\nEnd",
    recall: "Start End",
    generate: "Start\n<capability name=\"tts\" action=\"sing\">\nla la\n</capability>\nEnd",
    loopStrip: "Start\n<capability name=\"tts\" action=\"sing\">\nla la\n</capability>\nEnd",
  },
  {
    name: "<thinking> block",
    input: "<thinking>plan the reply</thinking>Answer here",
    outbound: "<thinking>plan the reply</thinking>Answer here",
    reply: "<thinking>plan the reply</thinking>Answer here",
    history: "<thinking>plan the reply</thinking>Answer here",
    recall: "<thinking>plan the reply</thinking>Answer here",
    generate: "Answer here",
    loopStrip: "<thinking>plan the reply</thinking>Answer here",
  },
  {
    name: "<think> block",
    input: "<think>plan the reply</think>Answer here",
    outbound: "<think>plan the reply</think>Answer here",
    reply: "Answer here",
    history: "<think>plan the reply</think>Answer here",
    recall: "<think>plan the reply</think>Answer here",
    generate: "<think>plan the reply</think>Answer here",
    loopStrip: "<think>plan the reply</think>Answer here",
  },
  {
    name: "<wants_loop>true",
    input: "Done for now <wants_loop>true</wants_loop>",
    outbound: "Done for now <wants_loop>true</wants_loop>",
    reply: "Done for now",
    history: "Done for now <wants_loop>true</wants_loop>",
    recall: "Done for now <wants_loop>true</wants_loop>",
    generate: "Done for now <wants_loop>true</wants_loop>",
    loopStrip: "Done for now",
  },
  {
    name: "<wants_loop>FALSE (case)",
    input: "Done <WANTS_LOOP>FALSE</WANTS_LOOP> ok",
    outbound: "Done <WANTS_LOOP>FALSE</WANTS_LOOP> ok",
    reply: "Done <WANTS_LOOP>FALSE</WANTS_LOOP> ok",
    history: "Done <WANTS_LOOP>FALSE</WANTS_LOOP> ok",
    recall: "Done <WANTS_LOOP>FALSE</WANTS_LOOP> ok",
    generate: "Done <WANTS_LOOP>FALSE</WANTS_LOOP> ok",
    loopStrip: "Done  ok",
  },
  {
    name: "<wants_loop> non-boolean body",
    input: "Done <wants_loop>maybe</wants_loop>",
    outbound: "Done <wants_loop>maybe</wants_loop>",
    reply: "Done",
    history: "Done <wants_loop>maybe</wants_loop>",
    recall: "Done <wants_loop>maybe</wants_loop>",
    generate: "Done <wants_loop>maybe</wants_loop>",
    loopStrip: "Done <wants_loop>maybe</wants_loop>",
  },
  {
    name: "<function_calls>/<invoke> closed",
    input: "Ok <function_calls><invoke name=\"x\"><parameter name=\"a\">1</parameter></invoke></function_calls> after",
    outbound: "Ok <function_calls><invoke name=\"x\"><parameter name=\"a\">1</parameter></invoke></function_calls> after",
    reply: "Ok  after",
    history: "Ok <function_calls><invoke name=\"x\"><parameter name=\"a\">1</parameter></invoke></function_calls> after",
    recall: "Ok <function_calls><invoke name=\"x\"><parameter name=\"a\">1</parameter></invoke></function_calls> after",
    generate: "Ok <function_calls><invoke name=\"x\"><parameter name=\"a\">1</parameter></invoke></function_calls> after",
    loopStrip: "Ok <function_calls><invoke name=\"x\"><parameter name=\"a\">1</parameter></invoke></function_calls> after",
  },
  {
    name: "<function_calls> unclosed to end",
    input: "Ok then <function_calls><invoke name=\"x\">trailing",
    outbound: "Ok then <function_calls><invoke name=\"x\">trailing",
    reply: "Ok then",
    history: "Ok then <function_calls><invoke name=\"x\">trailing",
    recall: "Ok then <function_calls><invoke name=\"x\">trailing",
    generate: "Ok then <function_calls><invoke name=\"x\">trailing",
    loopStrip: "Ok then <function_calls><invoke name=\"x\">trailing",
  },
  {
    name: "bare <invoke> unclosed",
    input: "Ok <invoke name=\"y\">param stuff",
    outbound: "Ok <invoke name=\"y\">param stuff",
    reply: "Ok",
    history: "Ok <invoke name=\"y\">param stuff",
    recall: "Ok <invoke name=\"y\">param stuff",
    generate: "Ok <invoke name=\"y\">param stuff",
    loopStrip: "Ok <invoke name=\"y\">param stuff",
  },
  {
    name: "<function_results> and stray closing tags",
    input: "A <function_results>r</function_results> B </invoke> C",
    outbound: "A <function_results>r</function_results> B </invoke> C",
    reply: "A  B  C",
    history: "A <function_results>r</function_results> B </invoke> C",
    recall: "A <function_results>r</function_results> B </invoke> C",
    generate: "A <function_results>r</function_results> B </invoke> C",
    loopStrip: "A <function_results>r</function_results> B </invoke> C",
  },
  {
    name: "<system-reminder>",
    input: "Hi <system-reminder>secret rules</system-reminder> there",
    outbound: "Hi <system-reminder>secret rules</system-reminder> there",
    reply: "Hi  there",
    history: "Hi <system-reminder>secret rules</system-reminder> there",
    recall: "Hi <system-reminder>secret rules</system-reminder> there",
    generate: "Hi <system-reminder>secret rules</system-reminder> there",
    loopStrip: "Hi <system-reminder>secret rules</system-reminder> there",
  },
  {
    name: "<security_reminder>",
    input: "<security_reminder>be safe</security_reminder>Real answer",
    outbound: "<security_reminder>be safe</security_reminder>Real answer",
    reply: "<security_reminder>be safe</security_reminder>Real answer",
    history: "Real answer",
    recall: "<security_reminder>be safe</security_reminder>Real answer",
    generate: "Real answer",
    loopStrip: "<security_reminder>be safe</security_reminder>Real answer",
  },
  {
    name: "<user_message> wrapper",
    input: "Echo <user_message from=\"x\">hello</user_message> back",
    outbound: "Echo <user_message from=\"x\">hello</user_message> back",
    reply: "Echo <user_message from=\"x\">hello</user_message> back",
    history: "Echo  back",
    recall: "Echo <user_message from=\"x\">hello</user_message> back",
    generate: "Echo <user_message from=\"x\">hello</user_message> back",
    loopStrip: "Echo <user_message from=\"x\">hello</user_message> back",
  },
  {
    name: "[USER_MESSAGE] bracket wrapper",
    input: "Echo [USER_MESSAGE]hello[/USER_MESSAGE] back",
    outbound: "Echo [USER_MESSAGE]hello[/USER_MESSAGE] back",
    reply: "Echo [USER_MESSAGE]hello[/USER_MESSAGE] back",
    history: "Echo [USER_MESSAGE]hello[/USER_MESSAGE] back",
    recall: "Echo [USER_MESSAGE]hello[/USER_MESSAGE] back",
    generate: "Echo  back",
    loopStrip: "Echo [USER_MESSAGE]hello[/USER_MESSAGE] back",
  },
  {
    name: "[SYSTEM: …] bracket",
    input: "Reply [SYSTEM: internal note] text",
    outbound: "Reply [SYSTEM: internal note] text",
    reply: "Reply [SYSTEM: internal note] text",
    history: "Reply [SYSTEM: internal note] text",
    recall: "Reply [SYSTEM: internal note] text",
    generate: "Reply  text",
    loopStrip: "Reply [SYSTEM: internal note] text",
  },
  {
    name: "<artie> wrapper tags",
    input: "<artie>hello there</artie>",
    outbound: "<artie>hello there</artie>",
    reply: "<artie>hello there</artie>",
    history: "<artie>hello there</artie>",
    recall: "<artie>hello there</artie>",
    generate: "hello there",
    loopStrip: "<artie>hello there</artie>",
  },
  {
    name: "[artie]: prefix",
    input: "[artie]: hello",
    outbound: "[artie]: hello",
    reply: "[artie]: hello",
    history: "[artie]: hello",
    recall: "[artie]: hello",
    generate: "hello",
    loopStrip: "[artie]: hello",
  },
  {
    name: "**Response:** prefix",
    input: "**Response:** hello",
    outbound: "**Response:** hello",
    reply: "**Response:** hello",
    history: "hello",
    recall: "**Response:** hello",
    generate: "hello",
    loopStrip: "**Response:** hello",
  },
  {
    name: "**Me:** then **Artie:** prefixes",
    input: "**Me:** **Artie:** hi",
    outbound: "**Me:** **Artie:** hi",
    reply: "**Me:** **Artie:** hi",
    history: "hi",
    recall: "**Me:** **Artie:** hi",
    generate: "hi",
    loopStrip: "**Me:** **Artie:** hi",
  },
  {
    name: "**Coach Artie:** prefix",
    input: "**Coach Artie:** yo",
    outbound: "**Coach Artie:** yo",
    reply: "**Coach Artie:** yo",
    history: "yo",
    recall: "**Coach Artie:** yo",
    generate: "yo",
    loopStrip: "**Coach Artie:** yo",
  },
  {
    name: "poisoned **Reply:** prefix",
    input: "**Reply:** hello",
    outbound: "**Reply:** hello",
    reply: "**Reply:** hello",
    history: "hello",
    recall: "**Reply:** hello",
    generate: "**Reply:** hello",
    loopStrip: "**Reply:** hello",
  },
  {
    name: "poisoned Here's my response: prefix",
    input: "Here's my response: hello",
    outbound: "Here's my response: hello",
    reply: "Here's my response: hello",
    history: "hello",
    recall: "Here's my response: hello",
    generate: "Here's my response: hello",
    loopStrip: "Here's my response: hello",
  },
  {
    name: "poisoned Response to your message: prefix",
    input: "Response to your message: hi",
    outbound: "Response to your message: hi",
    reply: "Response to your message: hi",
    history: "hi",
    recall: "Response to your message: hi",
    generate: "Response to your message: hi",
    loopStrip: "Response to your message: hi",
  },
  {
    name: "step marker line",
    input: "## Step 2/5 searching\nActual text",
    outbound: "## Step 2/5 searching\nActual text",
    reply: "## Step 2/5 searching\nActual text",
    history: "Actual text",
    recall: "## Step 2/5 searching\nActual text",
    generate: "## Step 2/5 searching\nActual text",
    loopStrip: "## Step 2/5 searching\nActual text",
  },
  {
    name: "[SILENT] alone",
    input: "[SILENT]",
    outbound: "[SILENT]",
    reply: "[SILENT]",
    history: "",
    recall: "[SILENT]",
    generate: "[SILENT]",
    loopStrip: "[SILENT]",
  },
  {
    name: "leading [SILENT] with chatter",
    input: "[SILENT] not worth it",
    outbound: "[SILENT] not worth it",
    reply: "[SILENT] not worth it",
    history: "",
    recall: "[SILENT] not worth it",
    generate: "[SILENT] not worth it",
    loopStrip: "[SILENT] not worth it",
  },
  {
    name: "embedded [SILENT]",
    input: "ok [SILENT] fine",
    outbound: "ok [SILENT] fine",
    reply: "ok [SILENT] fine",
    history: "ok [SILENT] fine",
    recall: "ok [SILENT] fine",
    generate: "ok [SILENT] fine",
    loopStrip: "ok [SILENT] fine",
  },
  {
    name: "[silent] lowercase",
    input: "[silent]",
    outbound: "[silent]",
    reply: "[silent]",
    history: "",
    recall: "[silent]",
    generate: "[silent]",
    loopStrip: "[silent]",
  },
  {
    name: "[SILENT] with meta parenthetical",
    input: "[SILENT]\n(that was a test)",
    outbound: "[SILENT]\n(that was a test)",
    reply: "[SILENT]\n(that was a test)",
    history: "",
    recall: "[SILENT]\n(that was a test)",
    generate: "[SILENT]\n(that was a test)",
    loopStrip: "[SILENT]\n(that was a test)",
  },
  {
    name: "<recall> tag",
    input: "<recall>x</recall> y",
    outbound: "<recall>x</recall> y",
    reply: "<recall>x</recall> y",
    history: "<recall>x</recall> y",
    recall: "x y",
    generate: "<recall>x</recall> y",
    loopStrip: "<recall>x</recall> y",
  },
  {
    name: "excess newlines and double spaces",
    input: "line1\n\n\n\nline2  and  more",
    outbound: "line1\n\n\n\nline2  and  more",
    reply: "line1\n\nline2  and  more",
    history: "line1\n\n\n\nline2  and  more",
    recall: "line1 line2 and more",
    generate: "line1\n\n\n\nline2  and  more",
    loopStrip: "line1\n\n\n\nline2  and  more",
  },
  {
    name: "nested/overlapping think and function_calls",
    input: "<think>a <function_calls>b</think> c</function_calls> d",
    outbound: "<think>a <function_calls>b</think> c</function_calls> d",
    reply: "c d",
    history: "<think>a <function_calls>b</think> c</function_calls> d",
    recall: "<think>a <function_calls>b</think> c</function_calls> d",
    generate: "<think>a <function_calls>b</think> c</function_calls> d",
    loopStrip: "<think>a <function_calls>b</think> c</function_calls> d",
  },
  {
    name: "capability inside think",
    input: "<think>x <capability name=\"a\"/> y</think> visible",
    outbound: "<think>x  y</think> visible",
    reply: "visible",
    history: "<think>x  y</think> visible",
    recall: "<think>x y</think> visible",
    generate: "<think>x <capability name=\"a\"/> y</think> visible",
    loopStrip: "<think>x <capability name=\"a\"/> y</think> visible",
  },
];

const CALLERS: Record<Exclude<keyof Row, 'name' | 'input'>, (t: string) => string> = {
  outbound: (t) => stripCapabilityXML(t),
  reply: (t) => cleanCapabilityTags(t),
  history: (t) => sanitizeAssistantMessage(t),
  recall: (t) => stripCapabilityTags(t),
  generate: (t) => coordinator.stripThinkingTags(t),
  loopStrip: (t) => coordinator.extractLoopDecision(t).response,
};

describe('LLM-output strippers, pinned per caller', () => {
  for (const row of ROWS) {
    describe(row.name, () => {
      for (const [caller, strip] of Object.entries(CALLERS)) {
        it(caller, () => {
          expect(strip(row.input)).toBe(row[caller as keyof typeof CALLERS]);
        });
      }
    });
  }
});
