# The "Other" box opens by default

> 2026-08-29. A revision to the prompt built in
> [`2026-08-15-agent-asks-a-question.md`](2026-08-15-agent-asks-a-question.md).
> That record settled what an `ask` is and who may answer it; this one changes
> one thing about how the answer is typed.

## 1. What this changes

### 1.1 Today

`QuestionPrompt.tsx` renders the agent's two-to-four options as buttons, and
below them a ghost button — "Something else…" — that swaps itself for a text
input when clicked. The free-text answer therefore costs a click before it costs
a keystroke.

The comment on that branch states the reason it was built that way:

> The escape hatch, collapsed until it is wanted: shown open it would read as a
> fifth option and compete with the four the agent actually offered.

### 1.2 Why that reason is being overruled

Because the competition it avoids is not the failure it should be optimising
against. The prompt's whole justification, in the earlier record's §3, is that a
person must not be cornered into the least-wrong option:

> 一个只能从三个选项里挑的问题，在选项都不对的时候会逼人挑一个最不坏的，然后 agent
> 拿着这个答案自信地做错事。

A collapsed box is a weaker version of that corner. When none of the options fit,
what the person sees is a row of answers that are all wrong plus a control whose
label reads as a fourth-ranked afterthought — and the cheapest move on that
screen is still to click an option. Making the box visible does not make the
free-text answer *louder* than the options; it makes it **as available as** them,
which is what "peek admits the agent may not have thought of everything" was
supposed to mean.

The cost this trades away is real but small: the prompt is one line taller, and
someone whose answer *is* one of the options now sees a control they will not
use. A text field does not look like a button, so it does not read as a fifth
option — the distinction the collapse was protecting is carried by the control's
own shape.

### 1.3 What the visible box breaks, and how it is repaired

Today the Send button appears when `question.multiSelect || writingOther`. With
the box always open, `writingOther` is permanently true, so **every single-choice
question would grow a Send button** — and that quietly repeals the rule the same
component's header states:

> A single-choice question answers on click. No confirm step: the click *is* the
> answer, exactly as it is on a permission prompt.

That rule is not collateral. It is the one thing making a question feel like the
permission prompt it sits in the same place as, and it stays. The Send button's
condition therefore moves from "the box is open" to **"the box has something in
it"**:

```
question.multiSelect || other.trim() !== ''
```

Single choice with an empty box: options answer on click, no Send, exactly as
before. Type one character and Send appears, because now there is an answer that
no click can complete. Multi-select: Send always, as before.

### 1.4 Boundary

- **Single- and multi-select are unchanged.** `ask` has taken `multiSelect`
  since the first version; nothing about the two modes moves except the Send
  condition above.
- **The box stays in the same vertical column as the options** — the existing
  `flex flex-col`, one item per row. Not a side-by-side split: the panel is
  narrow, and two columns would force the option labels to wrap at exactly the
  moment a person is trying to compare them.
- **No change below the renderer.** `chat.ask`, `chat.answer`, the broker, the
  tool schema and the `source: 'agent'` refusal are all untouched. The wire has
  always carried `optionIds[]` *and* `other` together.
- **The copy stays.** `chat.question.other` stops labelling a button and starts
  labelling the field; `chat.question.otherPlaceholder` still fills the empty
  box.

## 2. The approach

### 2.1 `QuestionPrompt.tsx`

| before | after |
| --- | --- |
| `writingOther` state, reset per question | gone — the box has no closed state |
| ghost button → input on click | the input, always, last in the option column |
| `autoFocus` on the input when it opened | no autofocus; the container keeps the initial focus |
| Escape collapsed the box and cleared it | Escape clears the text and returns focus to the container |
| Send when `multiSelect \|\| writingOther` | Send when `multiSelect \|\| other.trim() !== ''` |

Enter in the box still sends, and clicking an option in single-choice mode still
sends the typed text along with the option — "this one, but only for the EU
part" was already expressible and still is.

Dropping `autoFocus` matters more than it looks: an input that grabs focus the
moment a question arrives tells the person to type, when most questions are
answered by picking. Focus stays on the container, which is the rule the
permission prompt keeps and the reason a keystroke aimed at the composer cannot
answer by inertia.

### 2.2 Files

| file | change |
| --- | --- |
| `apps/desktop/src/renderer/components/chat/QuestionPrompt.tsx` | the table above, plus the header comment that documents the two rules |
| `docs/design/2026-08-29-the-other-box-opens-by-default.md` | this record |

No test changes. `control-spec.test.ts`'s "every control in the question prompt
stays human-only" keeps passing on its own terms — one fewer `<Button>` in the
file, and the two kinds that remain (options, Send) still carry
`exposure="human-only"`. The bus suite in `ask.test.ts` does not reach the DOM.

## 3. Trade-offs

**Keep the collapse and just make it cheaper** — a one-line input that expands on
focus, say. This is the collapse again with a smaller hinge: the person who
believes none of the options fit still has to discover that the control is an
input before they will aim at it.

**Give the box a heading like "Or answer in your own words"** to separate it from
the options. Rejected as a third piece of copy on a prompt that already carries a
header chip, a question, and a waiting line. The placeholder says the same thing
in a place that disappears once it is not needed.

**Show Send always, once the box is always open** (the alternative considered and
declined during review of this change). It is the simpler condition, and it costs
the click-is-the-answer rule on every single-choice question — two clicks for a
decision made in one, on the prompt whose entire visual argument is that it
behaves like the permission prompt beside it.

**Put the box beside the options in a two-column layout.** The chat panel can be
narrow enough that option labels already wrap; halving the width makes the agent's
own answers harder to read in order to promote peek's fallback. Same column,
last row.

## 4. Verification

1. **Single choice.** Ask a question with `multiSelect` unset. The text box is
   visible with no click; there is no Send button; clicking an option answers
   immediately and the agent continues in the same turn.
2. **Single choice, typed.** Type one character into the box — Send appears.
   Clear it — Send disappears. Enter in the box sends what was typed with no
   option selected, and the tool result carries `selected: []` plus the text.
3. **Single choice, both.** Type a condition, then click an option. The agent
   receives the option *and* the text.
4. **Multi-select.** Send is present from the start, disabled until something is
   picked or typed; picking two options and sending returns both.
5. **Focus.** When the question arrives, focus is on the bordered container, not
   in the text box: pressing Enter immediately does nothing. Tab reaches the
   options and then the box.
6. **Escape.** With text typed, Escape empties the box and puts focus back on the
   container; the question is still standing and unanswered.
7. **`pnpm -r test` and `pnpm -r typecheck` stay green**, `control-spec.test.ts`
   included.
