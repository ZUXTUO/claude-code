import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import { env } from '../../utils/env.js';

export type ClawdPose = 'default' | 'arms-up' | 'look-left' | 'look-right';

type Props = {
  pose?: ClawdPose;
};

export function Clawd(_props: Props = {}): React.ReactNode {
  if (env.terminal === 'Apple_Terminal') {
    return <AppleTerminalClawd />;
  }
  return (
    <Box flexDirection="column">
      {/* Row 1: empty */}
      <Text> </Text>
      {/* Row 2: ears */}
      <Text>
        <Text color="#CCCCCC">▀</Text>
        <Text color="#888888">{'▀▀   ▀▀'}</Text>
        <Text color="#CCCCCC">▀</Text>
      </Text>
      {/* Row 3: face */}
      <Text>
        <Text color="#ffb6c1">▀</Text>
        <Text color="#ff4444">{' ███▄█ '}</Text>
        <Text color="#ffb6c1">▀</Text>
      </Text>
    </Box>
  );
}

function AppleTerminalClawd(): React.ReactNode {
  return (
    <Box flexDirection="column" alignItems="center">
      <Text> </Text>
      <Text>
        <Text color="#CCCCCC">▀</Text>
        <Text color="#888888">{'▀▀   ▀▀'}</Text>
        <Text color="#CCCCCC">▀</Text>
      </Text>
      <Text>
        <Text color="#ffb6c1">▀</Text>
        <Text color="#ff4444">{' ███▄█ '}</Text>
        <Text color="#ffb6c1">▀</Text>
      </Text>
    </Box>
  );
}
