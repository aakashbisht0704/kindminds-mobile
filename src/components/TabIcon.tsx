/**
 * Tab glyphs.
 *
 * Hand-drawn SVG rather than an icon font: five icons is not worth a dependency,
 * and a stroke icon inherits the jade/ink colour directly from the tab state.
 */

import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

export type TabIconName = 'map' | 'chat' | 'aid' | 'kit' | 'sos';

export function TabIcon({
  name,
  color,
  size = 22,
}: {
  name: TabIconName;
  color: string;
  size?: number;
}) {
  const common = {
    stroke: color,
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none',
  };

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === 'map' ? (
        <>
          <Path d="M12 21s6.5-5.7 6.5-10.5a6.5 6.5 0 1 0-13 0C5.5 15.3 12 21 12 21z" {...common} />
          <Circle cx={12} cy={10.4} r={2.3} {...common} />
        </>
      ) : null}
      {name === 'chat' ? (
        <>
          <Path d="M4 5.5h16v10.5H9l-5 4V5.5z" {...common} />
          <Line x1={8} y1={10.5} x2={16} y2={10.5} {...common} />
          <Line x1={8} y1={13.5} x2={13} y2={13.5} {...common} />
        </>
      ) : null}
      {name === 'aid' ? (
        <>
          <Path
            d="M12 20.2S4.5 15.6 4.5 9.9A4.4 4.4 0 0 1 12 7a4.4 4.4 0 0 1 7.5 2.9c0 5.7-7.5 10.3-7.5 10.3z"
            {...common}
          />
          <Line x1={12} y1={10.2} x2={12} y2={14.2} {...common} />
          <Line x1={10} y1={12.2} x2={14} y2={12.2} {...common} />
        </>
      ) : null}
      {name === 'kit' ? (
        <>
          <Rect x={4} y={7.5} width={16} height={12.5} rx={3} {...common} />
          <Path d="M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5" {...common} />
          <Line x1={4} y1={12.5} x2={20} y2={12.5} {...common} />
          <Line x1={10} y1={12.5} x2={10} y2={15} {...common} />
          <Line x1={14} y1={12.5} x2={14} y2={15} {...common} />
        </>
      ) : null}
      {name === 'sos' ? (
        <>
          <Path d="M12 3.8 21 20H3L12 3.8z" {...common} />
          <Line x1={12} y1={9.5} x2={12} y2={14} {...common} />
          <Circle cx={12} cy={16.8} r={0.9} fill={color} stroke="none" />
        </>
      ) : null}
    </Svg>
  );
}
