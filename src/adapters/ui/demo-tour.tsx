import { useEffect, useRef, useState } from 'react';
import './demo-tour.css';

const STORAGE_KEY = 'vantage:lumen-demo-tour:v1';
let seenThisSession = false;
const steps = [
  { selector: '.pm-outline-row', title: 'Start with the why', text: 'Welcome to Lumen Trade, a fictional investing app. The vision connects the whole plan to customer outcomes. This quick tour takes about 30 seconds.' },
  { selector: '.pm-outline-row__type-tag--theme', row: true, title: 'Connect work to outcomes', text: 'Themes describe the results we want: funded accounts, informed first trades, and returning customers. Their weights express priority; components and features show how we get there.' },
  { selector: '.pm-outline-row__pill--unlock', title: 'See what unlocks what', text: 'These arrows show dependencies. After the tour, open one to trace how shared capabilities—like identity and the cash ledger—enable features across customer outcomes.' },
  { selector: '.pm-side-nav__current-card', title: 'Explore the same plan four ways', text: 'Use Outline for details, Visual Tree for connections, Gantt for planned dates, and Forecast for capacity and trade-offs. Try changing an estimate or comparing a saved scenario.' },
];
type Rect = { top: number; left: number; width: number; height: number };

/** Browser-local onboarding only; never writes project or collaboration facts. */
export function DemoTour({ enabled }: { enabled: boolean }) {
  const [active, setActive] = useState(false);
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const dialog = useRef<HTMLDialogElement>(null);
  const next = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!enabled) { setActive(false); return; }
    if (seenThisSession) return;
    try { if (localStorage.getItem(STORAGE_KEY)) return; } catch { /* Storage may be unavailable. */ }
    // Wait for project switching and its restored view state to settle before
    // consuming the first-visit marker or moving keyboard focus.
    const timer = window.setTimeout(() => {
      seenThisSession = true;
      try { localStorage.setItem(STORAGE_KEY, 'seen'); } catch { /* Session memory still prevents repeats. */ }
      setActive(true);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [enabled]);

  useEffect(() => {
    if (!active) return;
    const el = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    el?.showModal();
    next.current?.focus();
    return () => { el?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const found = document.querySelector(steps[step].selector);
    const target = steps[step].row ? found?.closest('.pm-outline-row') : found;
    const measure = () => {
      const width = window.innerWidth, height = window.innerHeight;
      setViewport({ width, height });
      const bounds = target?.getBoundingClientRect();
      if (!bounds || bounds.width === 0 || bounds.bottom <= 0 || bounds.top >= height) { setRect(null); return; }
      const left = Math.max(8, bounds.left - 6), top = Math.max(8, bounds.top - 6);
      setRect({ left, top, width: Math.max(0, Math.min(width - 8, bounds.right + 6) - left), height: Math.max(0, Math.min(height - 8, bounds.bottom + 6) - top) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (target) observer.observe(target);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    next.current?.focus();
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [active, step]);

  if (!active) return null;
  const cardWidth = Math.min(360, viewport.width - 32);
  const left = Math.max(16, Math.min(rect ? rect.left : (viewport.width - cardWidth) / 2, viewport.width - cardWidth - 16));
  const below = rect ? rect.top + rect.height + 16 : 100;
  const top = below + 280 < viewport.height ? below : Math.max(16, (rect?.top ?? viewport.height) - 280);
  const dismiss = () => setActive(false);
  return <dialog ref={dialog} className="pm-demo-tour" aria-labelledby="demo-tour-title" aria-describedby="demo-tour-description" onCancel={event => { event.preventDefault(); dismiss(); }}>
    {rect ? <div aria-hidden="true">
      <div className="pm-demo-tour__shade" style={{ inset: `0 0 auto 0`, height: rect.top }} />
      <div className="pm-demo-tour__shade" style={{ left: 0, top: rect.top, width: rect.left, height: rect.height }} />
      <div className="pm-demo-tour__shade" style={{ left: rect.left + rect.width, right: 0, top: rect.top, height: rect.height }} />
      <div className="pm-demo-tour__shade" style={{ top: rect.top + rect.height, bottom: 0, left: 0, right: 0 }} />
      <div className="pm-demo-tour__spotlight" style={rect} />
    </div> : <div className="pm-demo-tour__shade" style={{ inset: 0 }} aria-hidden="true" />}
    <section className="pm-demo-tour__card" style={{ left, top, width: cardWidth, maxHeight: viewport.height - top - 16 }}>
      <p className="pm-demo-tour__progress" aria-live="polite">Quick tour · {step + 1} of {steps.length}</p>
      <h2 id="demo-tour-title">{steps[step].title}</h2>
      <p id="demo-tour-description">{steps[step].text}</p>
      <div className="pm-demo-tour__actions">
        <button type="button" onClick={dismiss}>Skip tour</button>
        <span />
        {step > 0 && <button type="button" onClick={() => setStep(step - 1)}>Back</button>}
        <button ref={next} className="pm-demo-tour__next" type="button" onClick={() => step === steps.length - 1 ? dismiss() : setStep(step + 1)}>{step === steps.length - 1 ? 'Explore demo' : 'Next'}</button>
      </div>
    </section>
  </dialog>;
}
