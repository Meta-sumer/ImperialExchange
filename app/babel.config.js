module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      [
        'module-resolver',
        {
          root: ['./'],
          alias: { '@': './src' },
          extensions: ['.ts', '.tsx', '.js', '.json'],
        },
      ],
      // Reanimated 4 moved its worklet transform into react-native-worklets;
      // 'react-native-reanimated/plugin' no longer exists and Metro fails to
      // resolve it. This must stay LAST.
      'react-native-worklets/plugin',
    ],
  };
};
