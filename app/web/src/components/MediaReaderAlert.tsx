import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { MissingReader } from '@/lib/upload-formats';

/**
 * Shown instead of uploading an audio file or image into a folder whose data
 * agents can't read it. Names the switch to flip (the labels match
 * DataAgents.tsx's READERS) rather than failing after the upload.
 */
export function MediaReaderAlert({
  missing,
  folderName,
  onClose,
}: {
  missing: MissingReader | null;
  folderName?: string;
  onClose: () => void;
}) {
  const audio = missing?.capability === 'audio';
  const agent = audio ? 'Transcribe audio' : 'Read images';
  const where = folderName ? `“${folderName}”` : 'this folder';
  return (
    <AlertDialog open={!!missing} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{audio ? 'This folder can’t transcribe audio yet' : 'This folder can’t read images yet'}</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-medium text-foreground">{missing?.file}</span> wasn’t uploaded. {audio ? 'Audio' : 'Images'}{' '}
            are turned into text by a data agent, and {where} doesn’t have one for {audio ? 'speech-to-text' : 'images'}{' '}
            switched on.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p className="text-sm text-muted-foreground">
          Open the folder in <span className="font-medium text-foreground">Your Knowledge</span>, turn on{' '}
          <span className="font-medium text-foreground">{agent}</span> under Data agents, then upload the file again.
          Only folder managers can change data agents — if you can’t, ask one.
        </p>
        <AlertDialogFooter>
          <AlertDialogAction onClick={onClose}>OK</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
