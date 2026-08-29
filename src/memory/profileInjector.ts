// Inject the learner profile (L3 profile.md) into the tutor's system prompt.
//
// Pure: takes a base system prompt + the serialized profile markdown and
// returns the augmented prompt. The profile is truncated to a character
// budget so a large profile never silently blows the context window.

export interface ProfileInjectionOptions {
  /** Max characters of the profile to inject (truncated, not errored). */
  profileBudget: number;
}

export const DEFAULT_PROFILE_BUDGET = 2000;

export function injectProfile(
  baseSystemPrompt: string,
  profileMd: string | null | undefined,
  opts: ProfileInjectionOptions = { profileBudget: DEFAULT_PROFILE_BUDGET }
): string {
  const profile = (profileMd ?? "").trim();
  if (!profile) return baseSystemPrompt;

  const truncated = profile.slice(0, opts.profileBudget);
  return `${baseSystemPrompt}

## Learner Profile
The following is the learner's profile. Use it to personalize your responses:
- Focus explanations on their areas for improvement
- Reference their strengths to build confidence
- Match their preferred learning style
- Skip topics they've already mastered

${truncated}`;
}
