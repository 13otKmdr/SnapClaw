import React, { useEffect, useRef } from 'react';
import { Animated, Platform, StyleSheet, Text, View } from 'react-native';

const WEB_STYLE_ID = 'snapclaw-processing-indicator-style';
const WEB_KEYFRAMES = `
@keyframes snapclawDotBounce {
  0%, 80%, 100% {
    transform: translateY(0px);
    opacity: 0.35;
  }
  40% {
    transform: translateY(-5px);
    opacity: 1;
  }
}
`;

const ensureWebAnimationStyles = () => {
  if (Platform.OS !== 'web') {
    return;
  }

  const runtimeDocument = (typeof globalThis !== 'undefined'
    ? (globalThis as any).document
    : undefined) as {
    getElementById?: (id: string) => unknown;
    createElement?: (tagName: string) => { id: string; textContent: string };
    head?: { appendChild?: (node: unknown) => void };
  } | undefined;

  if (!runtimeDocument?.createElement || !runtimeDocument?.head?.appendChild) {
    return;
  }

  if (runtimeDocument.getElementById?.(WEB_STYLE_ID)) {
    return;
  }

  const styleTag = runtimeDocument.createElement('style');
  styleTag.id = WEB_STYLE_ID;
  styleTag.textContent = WEB_KEYFRAMES;
  runtimeDocument.head.appendChild(styleTag);
};

type ProcessingIndicatorProps = {
  label?: string;
};

export const ProcessingIndicator: React.FC<ProcessingIndicatorProps> = ({ label = 'Working…' }) => {
  const nativeOffsets = useRef([
    new Animated.Value(0),
    new Animated.Value(0),
    new Animated.Value(0),
  ]).current;

  useEffect(() => {
    if (Platform.OS === 'web') {
      ensureWebAnimationStyles();
      return;
    }

    const animations = nativeOffsets.map((offset, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(index * 110),
          Animated.timing(offset, {
            toValue: -4,
            duration: 180,
            useNativeDriver: true,
          }),
          Animated.timing(offset, {
            toValue: 0,
            duration: 180,
            useNativeDriver: true,
          }),
          Animated.delay(240),
        ]),
      ),
    );

    animations.forEach((animation) => animation.start());
    return () => animations.forEach((animation) => animation.stop());
  }, [nativeOffsets]);

  return (
    <View style={styles.container} accessibilityRole="progressbar" accessibilityLabel={label}>
      <View style={styles.dotsWrap}>
        {[0, 1, 2].map((index) => {
          if (Platform.OS === 'web') {
            return (
              <View
                key={index}
                style={[
                  styles.dot,
                  {
                    animationName: 'snapclawDotBounce',
                    animationDuration: '900ms',
                    animationIterationCount: 'infinite',
                    animationTimingFunction: 'ease-in-out',
                    animationDelay: `${index * 120}ms`,
                  } as any,
                ]}
              />
            );
          }

          return (
            <Animated.View
              key={index}
              style={[
                styles.dot,
                {
                  transform: [{ translateY: nativeOffsets[index] }],
                  opacity: nativeOffsets[index].interpolate({
                    inputRange: [-4, 0],
                    outputRange: [1, 0.45],
                  }),
                },
              ]}
            />
          );
        })}
      </View>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 8,
  },
  dotsWrap: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 5,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#7c7cff',
    opacity: 0.45,
  },
  label: {
    color: '#8f8fff',
    fontSize: 13,
  },
});

export default ProcessingIndicator;
