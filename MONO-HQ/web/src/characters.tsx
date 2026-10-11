import type { ReactNode } from 'react';
import type { AgentId, AgentLiveStatus } from '../../shared/contract.ts';

/** Shared gradients / clip paths. Mounted once at the app root. */
export function SceneDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="mh-wood" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#d9b27f" />
          <stop offset="1" stopColor="#b88658" />
        </linearGradient>
        <linearGradient id="mh-wood-dark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7a5738" />
          <stop offset="1" stopColor="#4f3823" />
        </linearGradient>
        <radialGradient id="mh-lamp-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#ffd89a" stopOpacity="0.85" />
          <stop offset="0.45" stopColor="#ffc873" stopOpacity="0.28" />
          <stop offset="1" stopColor="#ffc873" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="mh-screen-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#9cf4bd" stopOpacity="0.55" />
          <stop offset="1" stopColor="#9cf4bd" stopOpacity="0" />
        </radialGradient>
        <clipPath id="mh-screen-clip"><rect x="150" y="68" width="46" height="24" rx="2" /></clipPath>
      </defs>
    </svg>
  );
}

interface Look {
  skin: string;
  outfit: string;
  outfitDark: string;
}
const LOOKS: Record<AgentId, Look> = {
  mono: { skin: '#f0c9a6', outfit: '#223f66', outfitDark: '#162b47' },
  scout: { skin: '#c98d5f', outfit: '#b98b5a', outfitDark: '#8d683f' },
  ledger: { skin: '#f4d2b4', outfit: '#3d6fa6', outfitDark: '#2b5282' },
  flow: { skin: '#a8714a', outfit: '#1f8f86', outfitDark: '#16665f' },
  credit: { skin: '#e8bd98', outfit: '#6a5a49', outfitDark: '#4a3e32' },
  budget: { skin: '#8d5a3b', outfit: '#3f9b6b', outfitDark: '#2c7650' },
  radar: { skin: '#f1c7a1', outfit: '#e08a3c', outfitDark: '#b6671f' },
  guardian: { skin: '#5a3a28', outfit: '#2c3440', outfitDark: '#1d232c' },
};

/** Things that go behind the head (long hair etc.) */
function HairBack({ id }: { id: AgentId }): ReactNode {
  if (id === 'budget') return <path d="M122 48 C140 48 142 70 134 86 C130 76 128 66 122 62Z" fill="#7a3b1d" className="pony" />;
  return null;
}

function HairFront({ id }: { id: AgentId }): ReactNode {
  switch (id) {
    case 'mono':
      return <path d="M95 58 C93 41 104 38 111 38 C120 38 127 43 125 58 C122 50 118 47 110 47 C103 47 98 50 95 58Z" fill="#2a2018" />;
    case 'scout':
      return (
        <>
          <path d="M95 57 C95 49 98 47 98 47 L98 57Z" fill="#4a3220" />
          <path d="M92 50 C93 36 127 36 128 50Z" fill="#5b6b3a" />
          <path d="M90 50 L130 50 L134 54 L88 54Z" fill="#46532c" />
        </>
      );
    case 'ledger':
      return (
        <>
          <circle cx="110" cy="35" r="8" fill="#4a2c1d" />
          <path d="M95 58 C93 42 104 40 111 40 C120 40 127 43 125 58 C122 49 117 46 110 46 C103 46 98 49 95 58Z" fill="#4a2c1d" />
        </>
      );
    case 'flow':
      return (
        <g fill="#2d1b12">
          <circle cx="98" cy="48" r="8" /><circle cx="110" cy="42" r="9.5" /><circle cx="122" cy="48" r="8" />
          <circle cx="94" cy="58" r="6" /><circle cx="126" cy="58" r="6" />
        </g>
      );
    case 'credit':
      return (
        <>
          <path d="M95 60 C94 52 96 48 98 47 C97 53 97 57 98 62Z" fill="#c6ccd0" />
          <path d="M125 60 C126 52 124 48 122 47 C123 53 123 57 122 62Z" fill="#c6ccd0" />
        </>
      );
    case 'budget':
      return (
        <>
          <path d="M95 58 C93 41 104 38 111 38 C120 38 128 43 125 58 C121 50 117 47 110 47 C103 47 98 50 95 58Z" fill="#7a3b1d" />
          <circle cx="126" cy="50" r="3" fill="#f5d36a" />
        </>
      );
    case 'radar':
      return (
        <>
          <path d="M94 56 C92 40 128 40 126 56 C125 46 95 46 94 56Z" fill="#e8c46a" />
        </>
      );
    case 'guardian':
      return <path d="M95 54 C95 41 125 41 125 54 C120 47 100 47 95 54Z" fill="#141414" />;
  }
}

/** Accessories drawn on/around the face and body (above torso, below desk). */
function Accessories({ id }: { id: AgentId }): ReactNode {
  switch (id) {
    case 'mono':
      return (
        <>
          <path d="M101 82 L110 97 L119 82Z" fill="#f4f7f8" />
          <path d="M108.5 90 L111.5 90 L113 101 L110 104 L107 101Z" fill="#9cf4bd" />
          <path d="M101 82 L106 100 L98 96Z M119 82 L114 100 L122 96Z" fill="#162b47" />
          <path d="M95 56 A15 17 0 0 1 125 56" fill="none" stroke="#cfd8dc" strokeWidth="2.6" />
          <circle cx="94.5" cy="62" r="4" fill="#cfd8dc" /><circle cx="125.5" cy="62" r="4" fill="#cfd8dc" />
          <path d="M94 66 Q96 74 104 73" fill="none" stroke="#cfd8dc" strokeWidth="1.6" />
          <circle cx="104.5" cy="73" r="1.8" fill="#9cf4bd" />
        </>
      );
    case 'scout':
      return (
        <>
          <path d="M98 82 L110 92 L122 82 L118 79 L110 85 L102 79Z" fill="#d8b283" />
          <circle cx="110" cy="96" r="1.4" fill="#6b4c2b" /><circle cx="110" cy="102" r="1.4" fill="#6b4c2b" />
          <path d="M96 54 Q94 60 96 66" stroke="#4a3220" strokeWidth="2" fill="none" />
        </>
      );
    case 'ledger':
      return (
        <>
          <path d="M101 82 L110 94 L119 82Z" fill="#f6efe2" />
          <path d="M101 82 L106 104 M119 82 L114 104" stroke="#2b5282" strokeWidth="1.6" />
          <g fill="none" stroke="#1f2328" strokeWidth="1.4">
            <circle cx="104" cy="61" r="5" /><circle cx="116" cy="61" r="5" /><path d="M109 61 h2" />
          </g>
          <path d="M127 55 L131 46" stroke="#f2c230" strokeWidth="2.2" strokeLinecap="round" />
        </>
      );
    case 'flow':
      return (
        <>
          <path d="M104 83 q6 6 12 0" fill="none" stroke="#16665f" strokeWidth="3" />
          <path d="M100 82 L99 96 M120 82 L121 96" stroke="#e9f6f4" strokeWidth="1.2" />
          <path d="M90 99 q4-5 8 0 t8 0 t8 0 t8 0 t8 0" fill="none" stroke="rgba(255,255,255,.55)" strokeWidth="1.6" />
          <path d="M93 62 A17 22 0 0 1 127 62" fill="none" stroke="#22262b" strokeWidth="3.4" />
          <rect x="88.5" y="57" width="8" height="13" rx="4" fill="#e9eef2" stroke="#22262b" strokeWidth="1.4" />
          <rect x="123.5" y="57" width="8" height="13" rx="4" fill="#e9eef2" stroke="#22262b" strokeWidth="1.4" />
        </>
      );
    case 'credit':
      return (
        <>
          <path d="M101 82 L110 95 L119 82Z" fill="#f6f2ea" />
          <path d="M92 90 L104 104 L92 104Z M128 90 L116 104 L128 104Z" fill="#4a3e32" />
          <path d="M107.5 87 L110 90 L107.5 93Z M112.5 87 L110 90 L112.5 93Z" fill="#c0392b" />
          <circle cx="110" cy="90" r="1.6" fill="#a02e22" />
          <path d="M96 64 C98 82 122 82 124 64 C121 72 99 72 96 64Z" fill="#c6ccd0" />
          <path d="M100 55 l7 -1.5 M113 53.5 l7 1.5" stroke="#9aa1a6" strokeWidth="2.4" strokeLinecap="round" />
        </>
      );
    case 'budget':
      return (
        <>
          <rect x="99" y="76" width="22" height="9" rx="4.5" fill="#2c7650" />
          <path d="M96 100 q14 6 28 0" fill="none" stroke="rgba(255,255,255,.4)" strokeWidth="1.6" />
        </>
      );
    case 'radar':
      return (
        <>
          <path d="M92 56 C90 42 130 42 128 56 L127 66 L123 66 L123 56 C118 50 102 50 97 56 L97 66 L93 66Z" fill="#6b4a2f" />
          <rect x="91" y="54" width="6" height="14" rx="3" fill="#5a3d26" /><rect x="123" y="54" width="6" height="14" rx="3" fill="#5a3d26" />
          <circle cx="103" cy="47" r="5.2" fill="#7ad7f0" stroke="#2b2b2b" strokeWidth="1.6" />
          <circle cx="117" cy="47" r="5.2" fill="#7ad7f0" stroke="#2b2b2b" strokeWidth="1.6" />
          <path d="M97 47 h-5 M123 47 h5" stroke="#2b2b2b" strokeWidth="1.6" />
          <path d="M96 84 q14 8 28 0 l2 8 q-16 8 -32 0z" fill="#9cf4bd" />
          <path d="M100 82 L110 96 L120 82" fill="none" stroke="#b6671f" strokeWidth="2" />
        </>
      );
    case 'guardian':
      return (
        <>
          <path d="M101 82 L110 96 L119 82Z" fill="#f4f7f8" />
          <path d="M101 82 L105 104 L96 98Z M119 82 L115 104 L124 98Z" fill="#1d232c" />
          <path d="M122 90 l7 2.5 v6 c0 4 -3 6.5 -7 8 c-4 -1.5 -7 -4 -7 -8 v-6z" fill="#9cf4bd" stroke="#0f1a22" strokeWidth="1" transform="translate(2,-2) scale(.85)" />
          <path d="M123 96 l2.4 2.6 4.6 -5" fill="none" stroke="#0f1a22" strokeWidth="1.6" transform="translate(1,-2)" />
          <circle cx="125.5" cy="63" r="2.2" fill="#22262b" />
          <path d="M126 65 C130 72 128 78 120 83" fill="none" stroke="#22262b" strokeWidth="1.1" />
        </>
      );
  }
}

/** Little item that sits on the desk between lamp and person. */
function Prop({ id, working }: { id: AgentId; working: boolean }): ReactNode {
  switch (id) {
    case 'mono':
      return (
        <g>
          <rect x="52" y="94" width="14" height="10" rx="2" fill="#f1ece0" />
          <rect x="54" y="97" width="10" height="1.5" fill="#9cb0bf" /><rect x="54" y="100" width="7" height="1.5" fill="#9cb0bf" />
          <circle cx="63" cy="95" r="3" fill="#9cf4bd" />
        </g>
      );
    case 'scout':
      return (
        <g>
          <circle cx="60" cy="94" r="7" fill="rgba(160,230,240,.25)" stroke="#d9c27a" strokeWidth="2" />
          <path d="M65 99 L72 105" stroke="#d9c27a" strokeWidth="3" strokeLinecap="round" />
          <path d="M56 91 q3 -3 7 -1" stroke="#fff" strokeOpacity=".6" fill="none" strokeWidth="1.2" />
        </g>
      );
    case 'ledger':
      return (
        <g>
          <rect x="52" y="97" width="16" height="7" rx="1" fill="#e9e3d3" /><rect x="53" y="93" width="16" height="4.5" rx="1" fill="#f6f1e4" />
          <rect x="55" y="94.5" width="9" height="1" fill="#8a96a0" />
        </g>
      );
    case 'flow':
      return (
        <g>
          <path d="M55 95 h12 l-1.2 9 h-9.6z" fill="#f4f4f4" /><path d="M67 97 q4 0 4 3 t-4 3" fill="none" stroke="#f4f4f4" strokeWidth="1.6" />
          <rect x="55" y="95" width="12" height="3" fill="#7a4a2a" />
          {working ? <path className="steam" d="M58 92 q-2 -3 0 -5 M63 92 q-2 -3 0 -5" fill="none" stroke="rgba(255,255,255,.7)" strokeWidth="1.1" /> : null}
        </g>
      );
    case 'credit':
      return (
        <g>
          <rect x="53" y="90" width="14" height="14" rx="2" fill="#39424b" /><rect x="55" y="92" width="10" height="3.5" fill="#9cf4bd" />
          <g fill="#aab6bf">
            {[0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => <rect key={`${r}${c}`} x={55 + c * 3.6} y={97 + r * 2.6} width="2.6" height="1.8" />))}
          </g>
        </g>
      );
    case 'budget':
      return (
        <g>
          <ellipse cx="60" cy="98" rx="9" ry="6.5" fill="#f2a7b8" />
          <path d="M54 93 l1.5 -4 l3 3z" fill="#e58aa0" />
          <ellipse cx="68" cy="99" rx="2.6" ry="2" fill="#e58aa0" />
          <rect x="57" y="103" width="2.6" height="3" fill="#e58aa0" /><rect x="62.5" y="103" width="2.6" height="3" fill="#e58aa0" />
          <rect x="58" y="91.8" width="6" height="1.4" rx=".7" fill="#7b4256" />
          <circle cx="56.5" cy="97" r="1" fill="#3a2430" />
        </g>
      );
    case 'radar':
      return (
        <g>
          <circle cx="60" cy="96" r="9" fill="#10252b" stroke="#9cf4bd" strokeWidth="1.4" />
          <circle cx="60" cy="96" r="4.5" fill="none" stroke="#9cf4bd" strokeOpacity=".5" strokeWidth=".8" />
          <g className={working ? 'sweep' : ''}><path d="M60 96 L60 87.5" stroke="#9cf4bd" strokeWidth="1.6" strokeLinecap="round" /></g>
          <circle cx="64" cy="92" r="1.2" fill="#ffb2a9" />
        </g>
      );
    case 'guardian':
      return (
        <g>
          <path d="M55.5 94 v-3 a5 5 0 0 1 10 0 v3" fill="none" stroke="#cfd8dc" strokeWidth="2.2" />
          <rect x="53" y="94" width="15" height="11" rx="2.5" fill="#e0b55a" />
          <circle cx="60.5" cy="98.5" r="1.6" fill="#4a3510" /><rect x="59.9" y="99" width="1.2" height="3" fill="#4a3510" />
        </g>
      );
  }
}

type ScreenKind = 'lines' | 'rows' | 'bars' | 'chart' | 'hbars' | 'radar' | 'shield';
const SCREEN: Record<AgentId, ScreenKind> = {
  mono: 'lines', scout: 'lines', ledger: 'rows', flow: 'bars', credit: 'chart', budget: 'hbars', radar: 'radar', guardian: 'shield',
};

function ScreenContent({ kind }: { kind: ScreenKind }): ReactNode {
  const c = '#9cf4bd';
  switch (kind) {
    case 'lines':
      return (
        <g className="scr-scroll" fill={c}>
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <rect key={i} x={154} y={71 + i * 6} width={[30, 22, 36, 18, 28, 34, 20, 26][i]} height="2.4" rx="1.2" opacity={i % 3 === 0 ? 1 : 0.6} />
          ))}
        </g>
      );
    case 'rows':
      return (
        <g className="scr-scroll">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <g key={i} transform={`translate(0 ${70 + i * 6})`}>
              <rect x="154" y="0" width="8" height="2.4" rx="1.2" fill="#95c9f4" />
              <rect x="166" y="0" width="16" height="2.4" rx="1.2" fill={c} opacity=".7" />
              <rect x="186" y="0" width="7" height="2.4" rx="1.2" fill={i % 2 ? '#ffb2a9' : c} />
            </g>
          ))}
        </g>
      );
    case 'bars':
      return (
        <g fill={c}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <rect key={i} className="scr-bar" style={{ animationDelay: `${i * 0.18}s` }} x={155 + i * 6.8} y="70" width="4.4" height="19" rx="1" />
          ))}
        </g>
      );
    case 'chart':
      return (
        <g fill="none" stroke={c} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path className="scr-draw" d="M153 88 L161 80 L168 84 L176 74 L184 78 L193 70" />
          <path d="M153 90 H194" stroke="#95c9f4" strokeOpacity=".5" strokeWidth=".8" />
        </g>
      );
    case 'hbars':
      return (
        <g>
          {[0, 1, 2].map((i) => (
            <g key={i}>
              <rect x="154" y={72 + i * 7} width="40" height="3.6" rx="1.8" fill="#2c4a57" />
              <rect className="scr-hbar" style={{ animationDelay: `${i * 0.35}s` }} x="154" y={72 + i * 7} width={[30, 20, 36][i]} height="3.6" rx="1.8" fill={i === 2 ? '#efb07c' : c} />
            </g>
          ))}
        </g>
      );
    case 'radar':
      return (
        <g>
          <circle cx="173" cy="80" r="10" fill="none" stroke={c} strokeOpacity=".5" strokeWidth=".8" />
          <circle cx="173" cy="80" r="5" fill="none" stroke={c} strokeOpacity=".4" strokeWidth=".8" />
          <g className="scr-sweep"><path d="M173 80 L173 70" stroke={c} strokeWidth="1.6" strokeLinecap="round" /><path d="M173 80 L180 73 A10 10 0 0 0 173 70Z" fill={c} opacity=".25" /></g>
          <circle className="scr-blip" cx="178" cy="77" r="1.5" fill="#ffb2a9" />
        </g>
      );
    case 'shield':
      return (
        <g>
          <path d="M173 70 l9 3 v6 c0 5 -4 8 -9 10 c-5 -2 -9 -5 -9 -10 v-6z" fill="none" stroke={c} strokeWidth="1.6" />
          <path className="scr-draw" d="M168.5 79 l3.4 3.4 6 -6.6" fill="none" stroke={c} strokeWidth="1.8" strokeLinecap="round" />
        </g>
      );
  }
}

function ScreenStatic({ status }: { status: AgentLiveStatus }): ReactNode {
  if (status === 'failed' || status === 'blocked' || status === 'stale') {
    const col = status === 'failed' ? '#ffb2a9' : '#efb07c';
    return (
      <g fill={col}>
        <path d="M173 72 l8 14 h-16z" fill="none" stroke={col} strokeWidth="1.6" strokeLinejoin="round" />
        <rect x="172.2" y="76" width="1.6" height="5" rx=".8" /><circle cx="173" cy="83.6" r=".9" />
      </g>
    );
  }
  if (status === 'awaiting_approval' || status === 'awaiting_input') {
    return (
      <g fill="#d3b6fb">
        <rect x="167" y="73" width="4" height="13" rx="1.4" /><rect x="175" y="73" width="4" height="13" rx="1.4" />
      </g>
    );
  }
  return <circle cx="173" cy="80" r="1.6" fill="#4a6270" />; // idle standby dot
}

export interface SceneProps {
  id: AgentId;
  status: AgentLiveStatus;
}

/** The full desk scene for one agent. Animations only run when status === 'working'. */
export function DeskScene({ id, status }: SceneProps) {
  const look = LOOKS[id];
  const working = status === 'working';
  const lampOn = status !== 'failed';
  return (
    <svg className={`scene scene-${id} st-${status}`} viewBox="0 30 220 120" role="presentation" aria-hidden="true" focusable="false">
      {/* lamp + monitor glow (behind) */}
      <ellipse className="lamp-glow" cx="40" cy="74" rx="62" ry="58" fill="url(#mh-lamp-glow)" opacity={lampOn ? (working ? 1 : 0.5) : 0.15} />
      <ellipse className="screen-glow" cx="173" cy="82" rx="46" ry="34" fill="url(#mh-screen-glow)" opacity={working ? 0.9 : 0} />

      {/* person */}
      <g className="person">
        <HairBack id={id} />
        <g className="torso">
          <path d="M74 114 C74 90 90 81 110 81 C130 81 146 90 146 114Z" fill={look.outfit} />
          <path d="M74 114 C74 100 78 92 84 87 C80 96 80 106 84 114Z" fill={look.outfitDark} opacity=".5" />
          <Accessories id={id} />
        </g>
        <g className="head">
          <rect x="104" y="71" width="12" height="13" rx="4" fill={look.skin} />
          <ellipse cx="110" cy="60" rx="15" ry="17" fill={look.skin} />
          <circle cx="95" cy="62" r="3" fill={look.skin} /><circle cx="125" cy="62" r="3" fill={look.skin} />
          <HairFront id={id} />
          <g transform={working ? 'translate(0 1.2)' : undefined}>
            <g className="eyes" fill="#1b1f24"><circle cx="104" cy="61" r="1.9" /><circle cx="116" cy="61" r="1.9" /></g>
          </g>
          <path d="M99.5 55.5 q4.5 -2.4 8 -.4 M112.5 55.1 q3.5 -2 8 .4" fill="none" stroke="#1b1f24" strokeOpacity=".55" strokeWidth="1.4" strokeLinecap="round" />
          <path d={status === 'failed' || status === 'blocked' ? 'M105 70 q5 -2 10 0' : 'M105 68.6 q5 4 10 0'} fill="none" stroke="#6b2f2f" strokeWidth="1.6" strokeLinecap="round" />
          {id === 'credit' || id === 'ledger' || id === 'flow' || id === 'radar' ? null : <path d="M107 63.5 q3 3 6 0" fill="none" stroke="#000" strokeOpacity=".12" strokeWidth="1" />}
        </g>
      </g>

      {/* desk */}
      <rect x="10" y="104" width="200" height="14" rx="5" fill="url(#mh-wood)" />
      <rect x="10" y="104" width="200" height="3" rx="1.5" fill="#f1cf9f" opacity=".7" />
      <rect x="16" y="118" width="188" height="32" fill="url(#mh-wood-dark)" />
      <rect x="16" y="118" width="188" height="3" fill="#000" opacity=".25" />
      <rect x="94" y="124" width="32" height="5" rx="2.5" fill="#2c1e12" opacity=".7" />

      {/* prop */}
      <Prop id={id} working={working} />

      {/* keyboard */}
      <rect x="90" y="106" width="40" height="5" rx="2" fill="#2d3a45" />
      <rect x="92" y="107" width="36" height="1" fill="#4b5f6e" />

      {/* hands (typing) */}
      <g className="arms">
        <path d="M82 92 C78 106 86 110 97 110" fill="none" stroke={look.outfit} strokeWidth="9" strokeLinecap="round" />
        <path d="M138 92 C142 106 134 110 123 110" fill="none" stroke={look.outfit} strokeWidth="9" strokeLinecap="round" />
        <circle className="hand hand-l" cx="98" cy="108.5" r="4.6" fill={look.skin} />
        <circle className="hand hand-r" cx="122" cy="108.5" r="4.6" fill={look.skin} />
      </g>

      {/* lamp */}
      <g className="lamp">
        <ellipse cx="30" cy="104" rx="11" ry="3" fill="#2b3a46" />
        <path d="M30 103 L38 78 L48 66" fill="none" stroke="#2f3f4c" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M40 62 L56 66 L52 76 L38 70Z" fill={lampOn ? '#f2b45e' : '#4a4f55'} stroke="#2f3f4c" strokeWidth="1.2" />
        {lampOn ? <path d="M40 70 L52 76" stroke="#ffe3b0" strokeWidth="2.4" strokeLinecap="round" opacity={working ? 1 : 0.6} /> : null}
      </g>

      {/* monitor */}
      <g className="monitor">
        <rect x="167" y="95" width="12" height="8" fill="#26343f" />
        <ellipse cx="173" cy="104" rx="15" ry="2.6" fill="#26343f" />
        <rect x="146" y="64" width="54" height="32" rx="4" fill="#26343f" stroke="#3d5666" strokeWidth="1.4" />
        <rect x="150" y="68" width="46" height="24" rx="2" fill={working ? '#0d2a2c' : '#0f1c26'} />
        <g clipPath="url(#mh-screen-clip)">{working ? <ScreenContent kind={SCREEN[id]} /> : <ScreenStatic status={status} />}</g>
        <circle cx="173" cy="94.4" r="0.9" fill={working ? '#9cf4bd' : '#42586a'} />
      </g>
    </svg>
  );
}

/** Large portrait used in the drawer header. */
export function Portrait({ id, status }: SceneProps) {
  return (
    <div className="portrait" data-agent={id}>
      <DeskScene id={id} status={status} />
    </div>
  );
}
