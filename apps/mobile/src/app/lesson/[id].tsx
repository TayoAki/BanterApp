import { useMutation, useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SourceQuote } from '../../components/SourceQuote';
import { Body, Button, Card, ErrorBox, Eyebrow, Gap, Heading, Label, Loading, Pill, Row, Screen } from '../../components/ui';
import { api, ApiClientError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { setPendingRoute } from '../../lib/pending-route';
import { startSession } from '../../lib/practice';
import { colors, fontSizes, minTouch, radius, spacing } from '../../lib/theme';

export default function Lesson() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { status } = useAuth();
  const lesson = useQuery({ queryKey: ['lesson', id, status], queryFn: () => api.lesson(id!), enabled: !!id });
  const [picked, setPicked] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const practice = useMutation({
    mutationFn: () => startSession({ promptId: lesson.data!.prompt!.id, promptVersion: lesson.data!.prompt!.version, mode: 'lesson' }),
    onSuccess: (s) => router.push(`/practice/${s.session_id}/record`),
  });
  const conversation = useMutation({
    mutationFn: () => startSession({ promptId: lesson.data!.prompt!.id, promptVersion: lesson.data!.prompt!.version, mode: 'roleplay' }),
    onSuccess: (s) => router.push(`/practice/roleplay/${s.session_id}`),
  });

  if (lesson.isPending) {
    return (
      <Screen>
        <Loading label="Loading lesson" />
      </Screen>
    );
  }
  if (lesson.isError || !lesson.data) {
    return (
      <Screen>
        <ErrorBox message={lesson.error instanceof ApiClientError && lesson.error.status === 404 ? 'This lesson isn’t available.' : 'Couldn’t load the lesson.'} action={() => lesson.refetch()} actionTitle="Try again" />
        <Button title="Back" variant="ghost" onPress={() => router.back()} />
      </Screen>
    );
  }
  const l = lesson.data;
  const rec = l.recognition;
  const correct = checked && rec && picked === rec.answer_id;

  return (
    <Screen
      footer={
        l.stage !== 'notice' && l.prompt ? (
          status === 'signed_in' ? (
            <Button title="Practice this" onPress={() => practice.mutate()} loading={practice.isPending} />
          ) : (
            <Button
              title="Sign in to practice"
              onPress={() => {
                void setPendingRoute(`/lesson/${l.id}`);
                router.push('/auth');
              }}
            />
          )
        ) : undefined
      }>
      <Row style={{ justifyContent: 'space-between' }}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" style={styles.back}>
          <Text style={{ fontSize: 22, color: colors.ink }}>‹</Text>
        </Pressable>
        {l.publication_status !== 'published' ? <Pill tone="error">Draft · internal preview</Pill> : null}
      </Row>
      <Eyebrow>
        {l.app_title} · Framework {l.framework_number} · {l.stage}
      </Eyebrow>
      <Heading>{l.title}</Heading>

      <Card>
        <Label>What the framework states (original wording)</Label>
        <Text style={styles.statement} selectable>
          “{l.source_statement_verbatim}”
        </Text>
        <Label>
          {l.source_file} · p. {l.source_statement_page}
        </Label>
      </Card>

      <Card tone="lavender">
        <Label style={{ color: colors.ink, fontWeight: '600' }}>What this means (editorial)</Label>
        <Body>{l.explanation}</Body>
      </Card>

      <Body style={{ fontWeight: '700' }}>The original example</Body>
      <SourceQuote example={l.primary_example} />
      {l.examples.length > 1 ? (
        <>
          <Button title={showAll ? 'Hide other examples' : `Show ${l.examples.length - 1} more source ${l.examples.length - 1 === 1 ? 'example' : 'examples'}`} variant="ghost" onPress={() => setShowAll((v) => !v)} />
          {showAll ? l.examples.filter((e) => e.example_id !== l.primary_example.example_id).map((e) => <SourceQuote key={e.example_id} example={e} compact />) : null}
        </>
      ) : null}

      <Card>
        <Body style={{ fontWeight: '700' }}>Three practice targets</Body>
        {l.criteria.map((c) => (
          <View key={c.id} style={{ gap: 2 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Body style={{ fontWeight: '600' }}>{c.label}</Body>
              <Label>{c.origin === 'source_rule' ? 'source rule' : c.origin === 'example_derived' ? 'from the example' : 'exercise target'}</Label>
            </Row>
            <Label>{c.definition}</Label>
          </View>
        ))}
        <Label>Exercise targets are app practice conditions, not the author’s doctrine.</Label>
      </Card>

      {l.stage === 'notice' && rec ? (
        <Card>
          <Body style={{ fontWeight: '700' }}>Notice the move</Body>
          {l.notice_task ? <Body muted>{l.notice_task}</Body> : null}
          <Body>{rec.question}</Body>
          {rec.options.map((o) => {
            const isPicked = picked === o.id;
            const isAnswer = checked && o.id === rec.answer_id;
            return (
              <Pressable
                key={o.id}
                onPress={() => {
                  setPicked(o.id);
                  setChecked(false);
                }}
                accessibilityRole="radio"
                accessibilityState={{ checked: isPicked }}
                style={[styles.option, isPicked && styles.optionPicked, isAnswer && styles.optionAnswer, checked && isPicked && !isAnswer && styles.optionWrong]}>
                <Text style={styles.optionText}>“{o.text}”</Text>
              </Pressable>
            );
          })}
          {!checked ? (
            <Button title="Check" onPress={() => setChecked(true)} disabled={!picked} />
          ) : (
            <View style={{ gap: spacing.sm }}>
              <Pill tone={correct ? 'success' : 'accent'}>{correct ? 'That’s the move' : 'Not quite'}</Pill>
              {rec.rationale ? <Body>{rec.rationale}</Body> : null}
              {!correct ? <Button title="Try again" variant="secondary" onPress={() => setChecked(false)} /> : null}
              {rec.key_status !== 'reviewed' ? <Label>Answer key status: {rec.key_status.replace(/_/g, ' ')}.</Label> : null}
            </View>
          )}
        </Card>
      ) : null}

      {l.stage === 'notice' && !rec ? (
        <Card>
          <Body muted>The recognition task for this lesson is still being authored.</Body>
        </Card>
      ) : null}

      {l.prompt ? (
        <Card tone="lavender">
          <Label style={{ color: colors.ink, fontWeight: '600' }}>{l.stage === 'notice' ? 'Related prompt' : 'Your prompt'}</Label>
          <Body>{l.prompt.prompt}</Body>
          <Label>
            {l.prompt.target_seconds.min}–{l.prompt.target_seconds.max} seconds · {l.prompt.hard_limit_seconds}-second limit
            {l.prompt.kind === 'fictional_roleplay' ? ' · fictional scenario' : ''}
          </Label>
          {l.prompt.kind === 'fictional_roleplay' && l.stage !== 'notice' && status === 'signed_in' ? (
            <Button title="Practice as a short conversation" variant="secondary" onPress={() => conversation.mutate()} loading={conversation.isPending} accessibilityHint="Up to three exchanges with a fictional adult partner; uses one practice session" />
          ) : null}
        </Card>
      ) : null}
      {conversation.isError ? <ErrorBox message={conversation.error instanceof ApiClientError ? conversation.error.message : 'Couldn’t start the conversation.'} /> : null}
      {practice.isError ? <ErrorBox message={practice.error instanceof ApiClientError ? practice.error.message : 'Couldn’t start practice.'} /> : null}
      <Gap />
    </Screen>
  );
}

const styles = StyleSheet.create({
  back: { minWidth: 44, minHeight: 44, justifyContent: 'center' },
  statement: { fontSize: 20, lineHeight: 28, color: colors.ink, fontWeight: '600' },
  option: { minHeight: minTouch, justifyContent: 'center', padding: spacing.md, borderRadius: radius.button, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.canvas },
  optionPicked: { borderColor: colors.primary, borderWidth: 2 },
  optionAnswer: { borderColor: colors.success, backgroundColor: '#E3F3EA' },
  optionWrong: { borderColor: colors.error },
  optionText: { fontSize: fontSizes.body, lineHeight: 24, color: colors.ink, fontStyle: 'italic' },
});
