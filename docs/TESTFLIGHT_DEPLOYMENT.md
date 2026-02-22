# TestFlight Deployment Guide

This guide explains how to deploy the Voice Interface app to TestFlight for beta testing.

## Prerequisites

1. **Apple Developer Account** ($99/year)
2. **App Store Connect App** created
3. **EAS CLI** installed: `npm install -g eas-cli`
4. **Expo Account** (free)

## Initial Setup

### 1. Install EAS CLI
```bash
npm install -g eas-cli
```

### 2. Login to Expo
```bash
cd mobile
eas login
```

### 3. Configure Project
```bash
eas build:configure
```

### 4. Update Configuration

Edit `mobile/app.json`:
- Replace `com.voiceinterface.app` with your bundle identifier
- Replace `your-project-id-here` with your EAS project ID
- Replace `voice.yourdomain.com` with your actual domain

Edit `mobile/eas.json`:
- Replace `your-apple-id@email.com` with your Apple ID
- Replace `YOUR_APP_STORE_CONNECT_APP_ID` with your App Store Connect App ID
- Replace `YOUR_APPLE_TEAM_ID` with your Apple Team ID

## Building for TestFlight

### Development Build (for testing)
```bash
eas build --profile development --platform ios
```

### Preview Build (internal distribution)
```bash
eas build --profile preview --platform ios
```

### Production Build (for TestFlight)
```bash
eas build --profile production --platform ios
```

## Submitting to TestFlight

### 1. Wait for build to complete
```bash
eas build:list
```

### 2. Submit to App Store Connect
```bash
eas submit --profile production --platform ios
```

Or with specific build ID:
```bash
eas submit --platform ios --latest
```

### 3. Configure in App Store Connect
1. Go to [App Store Connect](https://appstoreconnect.apple.com)
2. Navigate to your app → TestFlight
3. Add beta testers
4. Submit for beta review (if required)

## Environment Variables

For production builds, set these in `eas.json` or via EAS secrets:

```bash
eas secret:create --scope project --name API_URL --value https://voice.yourdomain.com
eas secret:create --scope project --name JWT_SECRET --value your-jwt-secret
```

## Automating Deployment

Create a CI/CD pipeline with GitHub Actions:

```yaml
# .github/workflows/testflight.yml
name: Deploy to TestFlight

on:
  push:
    tags:
      - 'v*'

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '18'
      - name: Setup EAS
        run: npm install -g eas-cli
      - name: Build
        run: |
          cd mobile
          eas build --profile production --platform ios --non-interactive
        env:
          EXPO_TOKEN: ${{ secrets.EXPO_TOKEN }}
      - name: Submit
        run: |
          cd mobile
          eas submit --profile production --platform ios --latest
        env:
          EXPO_TOKEN: ${{ secrets.EXPO_TOKEN }}
```

## Troubleshooting

### Build Fails
- Check Apple certificates and provisioning profiles
- Verify bundle identifier matches App Store Connect
- Check Xcode version compatibility

### Submit Fails
- Verify Apple ID has Admin role
- Check app is in "Prepare for Submission" state
- Verify all required metadata is complete

### App Crashes on Launch
- Check API URL is accessible
- Verify SSL certificate is valid
- Check microphone permissions in Info.plist

## Testing Checklist

- [ ] API URL configured correctly
- [ ] SSL certificate valid
- [ ] Microphone permission requested
- [ ] Speech recognition permission requested
- [ ] Login/Register works
- [ ] Voice commands processed
- [ ] WebSocket connection stable
- [ ] Telegram integration works
- [ ] Agent Zero integration works
- [ ] OpenClaw integration works
