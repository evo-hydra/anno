import { describe, it, expect } from 'vitest';
import { detectChallengePage, detectAuthWall, isGatedPage } from '../core/wall-detector';

describe('wall-detector', () => {
  describe('detectChallengePage', () => {
    it('detects captcha', () => {
      const result = detectChallengePage('<div>Please solve the CAPTCHA</div>');
      expect(result).not.toBeNull();
      expect(result!.reason).toBe('captcha');
    });

    it('detects human verification', () => {
      const result = detectChallengePage('<p>Verify you are human</p>');
      expect(result).not.toBeNull();
      expect(result!.reason).toBe('human_verification');
    });

    it('detects robot check', () => {
      const result = detectChallengePage('<h1>Are you a robot?</h1>');
      expect(result).not.toBeNull();
      expect(result!.reason).toBe('robot_check');
    });

    it('detects access denied', () => {
      const result = detectChallengePage('<title>Access Denied</title>');
      expect(result).not.toBeNull();
      expect(result!.reason).toBe('access_denied');
    });

    it('detects PerimeterX', () => {
      const result = detectChallengePage('<script src="perimeterx.js"></script>');
      expect(result).not.toBeNull();
      expect(result!.reason).toBe('perimeterx');
    });

    it('detects javascript required', () => {
      const result = detectChallengePage('<noscript>Please enable JavaScript</noscript>');
      expect(result).not.toBeNull();
      expect(result!.reason).toBe('javascript_required');
    });

    it('detects unusual traffic', () => {
      const result = detectChallengePage('<p>We detected unusual traffic from your network</p>');
      expect(result).not.toBeNull();
      expect(result!.reason).toBe('unusual_traffic');
    });

    it('returns null for normal content', () => {
      expect(detectChallengePage('<h1>Hello World</h1><p>Article content here.</p>')).toBeNull();
    });

    it('only scans first 4KB of body', () => {
      const padding = 'x'.repeat(5000);
      const body = padding + 'CAPTCHA';
      expect(detectChallengePage(body)).toBeNull();
    });
  });

  describe('detectAuthWall', () => {
    it('detects sign in to view', () => {
      const result = detectAuthWall('<p>Sign in to view this content</p>');
      expect(result).not.toBeNull();
      expect(result!.reason).toBe('sign_in_required');
    });

    it('detects log in to continue', () => {
      const result = detectAuthWall('<p>Log in to continue reading</p>');
      expect(result).not.toBeNull();
      expect(result!.reason).toBe('login_required');
    });

    it('detects sign up to unlock', () => {
      const result = detectAuthWall('<p>Sign up to unlock this article</p>');
      expect(result).not.toBeNull();
      expect(result!.reason).toBe('signup_required');
    });

    it('detects subscribe to read', () => {
      const result = detectAuthWall('<p>Subscribe to read the full story</p>');
      expect(result).not.toBeNull();
      expect(result!.reason).toBe('paywall');
    });

    it('detects LinkedIn authwall', () => {
      const result = detectAuthWall('<div class="authwall">Join LinkedIn</div>');
      expect(result).not.toBeNull();
      expect(result!.reason).toBe('linkedin_authwall');
    });

    it('detects join LinkedIn', () => {
      const result = detectAuthWall('<h1>Join LinkedIn to see the full profile</h1>');
      expect(result).not.toBeNull();
      expect(result!.reason).toBe('linkedin_join');
    });

    it('detects sign in LinkedIn', () => {
      const result = detectAuthWall('<p>Sign in to LinkedIn</p>');
      expect(result).not.toBeNull();
      expect(result!.reason).toBe('linkedin_signin');
    });

    it('returns null for normal content', () => {
      expect(detectAuthWall('<h1>Public Article</h1><p>Great content here.</p>')).toBeNull();
    });

    it('does not false-positive on sidebar CTA beyond 4KB', () => {
      const article = '<h1>Real Article</h1>' + '<p>Content. </p>'.repeat(300);
      const body = article + '<footer>Sign in to view more articles</footer>';
      // Only if the pattern appears beyond the 4KB scan window
      if (body.indexOf('Sign in to view') > 4096) {
        expect(detectAuthWall(body)).toBeNull();
      }
    });

    it('is case insensitive', () => {
      expect(detectAuthWall('<p>SIGN IN TO VIEW this content</p>')).not.toBeNull();
      expect(detectAuthWall('<p>Subscribe To Read more</p>')).not.toBeNull();
    });
  });

  describe('isGatedPage', () => {
    it('returns true for challenge pages', () => {
      expect(isGatedPage('<div>Please solve the CAPTCHA</div>')).toBe(true);
    });

    it('returns true for auth wall pages', () => {
      expect(isGatedPage('<p>Sign in to view this content</p>')).toBe(true);
    });

    it('returns false for normal pages', () => {
      expect(isGatedPage('<h1>Normal Article</h1><p>Content here</p>')).toBe(false);
    });

    it('returns true when both challenge and auth wall are present', () => {
      expect(isGatedPage('<div>CAPTCHA</div><p>Sign in to view</p>')).toBe(true);
    });
  });
});
