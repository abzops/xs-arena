import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Logo } from '../../components/ui';
import './landing.css';

// Interim landing page for XS Arena. The full owner-first page (live floor demo,
// receipt, WhatsApp, TV display) is built on Day 8 of the implementation plan.

const BRAND = `${import.meta.env.BASE_URL}brand/`;

const GROUPS: [string, string[]][] = [
  ['At the front desk', [
    'Your real floor: pool, snooker, PS5 and RC tracks where they actually are',
    'Walk-ins in ten seconds: tap a table, type the phone number, start',
    'Live timers, “free until” times and a waiting list',
    'Alerts on staff phones when time is almost up',
  ]],
  ['Billing', [
    'Per minute, per hour, per frame or per slot — with peak and happy-hour rates',
    'One bill for the whole group: tables, consoles and snacks',
    'UPI QR with the exact amount, split bills, cash and card',
    'Receipt on WhatsApp with in-time and out-time',
  ]],
  ['For owners', [
    'Today’s sales and busy tables on your phone',
    'Expenses and real net profit for the month',
    'Shift close that shows if cash is missing',
    'Owner, manager and front-desk logins with the right limits',
  ]],
];

function Mark({ dark = true }: { dark?: boolean }) {
  return (
    <span className={`lp-mark ${dark ? 'on-dark' : ''}`}>
      <img src={`${BRAND}${dark ? 'badge-white' : 'badge-black'}.svg`} alt="" width={30} height={30} />
      <span>Arena</span>
    </span>
  );
}

export function LandingPage() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    document.title = 'XS Arena — Run your gaming centre from your phone';
    const on = () => setScrolled(window.scrollY > 24);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);

  return (
    <div className="lp">
      <header className={`lp-nav ${scrolled ? 'scrolled' : ''}`}>
        <div className="lp-wrap lp-nav-in">
          <Link to="/" aria-label="XS Arena home"><Mark /></Link>
          <nav className="lp-links" aria-label="Sections">
            <a href="#features">Features</a><a href="#start">Getting started</a>
          </nav>
          <div className="row">
            <Link className="btn ghost on-dark" to="/login">Sign in</Link>
            <Link className="btn primary on-dark hide-phone" to="/login?mode=signup">Start free trial</Link>
          </div>
        </div>
      </header>

      <section className="lp-hero">
        <div className="lp-wrap">
          <div className="lp-hero-copy">
            <h1 className="rise" style={{ ['--d' as string]: '40ms' }}>Snooker, PS5, RC tracks. One app runs it all.</h1>
            <div className="lp-hero-side">
              <p className="rise" style={{ ['--d' as string]: '160ms' }}>
                Every table, console and track on one live floor. Timers, bills, snacks and expenses — and today’s money on your phone wherever you are.
              </p>
              <div className="row rise" style={{ ['--d' as string]: '260ms' }}>
                <Link className="btn primary on-dark lg" to="/login?mode=signup">Start 14-day free trial</Link>
                <Link className="btn on-dark lg" to="/login">Sign in</Link>
              </div>
              <p className="lp-hero-note rise" style={{ ['--d' as string]: '320ms' }}>No card needed. Nothing to install.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="lp-facts" aria-label="At a glance">
        <div className="lp-wrap lp-facts-in">
          <p><b>Nothing to install</b>Works on the phone, tablet, laptop or TV you have</p>
          <p><b>Keeps running offline</b>Timers don’t stop if the internet drops</p>
          <p><b>English and Malayalam</b>For customer messages on WhatsApp</p>
          <p><b>Stored in India</b>Each centre’s records kept separate</p>
        </div>
      </section>

      <section id="features" className="lp-section">
        <div className="lp-wrap">
          <div className="lp-head">
            <h2>Built for mixed gaming centres.</h2>
            <p>Not a restaurant till with a timer taped on. XS Arena is made for places that rent tables, consoles and tracks by time.</p>
          </div>
          <div className="lp-groups">
            {GROUPS.map(([title, items]) => (
              <div key={title} className="lp-group">
                <h3>{title}</h3>
                <ul>{items.map((t) => <li key={t}>{t}</li>)}</ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="start" className="lp-section tint">
        <div className="lp-wrap">
          <div className="lp-head">
            <h2>Set up in one afternoon.</h2>
            <ul className="ticks dark-ink">
              <li><Check size={18} /> Sign up and name your centre</li>
              <li><Check size={18} /> Draw your floor and drop in your tables, consoles and tracks</li>
              <li><Check size={18} /> Add your prices and your team — and take the first walk-in</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="lp-section dark cta">
        <div className="lp-wrap">
          <div className="cta-in">
            <h2>Try it on this weekend’s rush.</h2>
            <p>14 days, every feature, your own centre.</p>
            <div className="row">
              <Link className="btn primary on-dark lg" to="/login?mode=signup">Start free trial</Link>
              <Link className="btn on-dark lg" to="/login">Sign in</Link>
            </div>
            <p className="cta-note">Questions first? Write to <a href="mailto:support@xelorsoft.com">support@xelorsoft.com</a></p>
          </div>
        </div>
      </section>

      <footer className="lp-foot">
        <div className="lp-wrap lp-foot-in">
          <div className="lp-foot-brand">
            <Mark dark={false} />
            <p>Floor, timers, billing and expenses for gaming centres in India.</p>
          </div>
          <nav aria-label="Footer">
            <a href="#features">Features</a>
            <a href="#start">Getting started</a>
            <Link to="/login">Sign in</Link>
          </nav>
          <nav aria-label="Xelorsoft">
            <a href="https://xelorsoft.com">Xelorsoft</a>
            <a href="https://gym.xelorsoft.com">XS Gym</a>
            <a href="https://salon.xelorsoft.com">XS Salon</a>
            <a href="mailto:support@xelorsoft.com">support@xelorsoft.com</a>
          </nav>
        </div>
        <div className="lp-wrap lp-foot-base">
          <a href="https://xelorsoft.com" aria-label="Xelorsoft"><Logo width={96} /></a>
          <span>© 2026 Xelorsoft</span>
        </div>
      </footer>
    </div>
  );
}
