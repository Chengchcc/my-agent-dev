"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Upload } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Form, FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { useInstallGitPack, useUploadZipPack } from "@/features/skill-packs/hooks";
import { formatBytes, useFileUpload } from "@/hooks/use-file-upload";

const gitFormSchema = z.object({
  url: z.string().trim().min(1, "Repository URL is required"),
  ref: z.string().trim().optional(),
  keepSynced: z.boolean().default(false),
  name: z.string().trim().min(1, "Name is required"),
  description: z.string().trim().optional(),
});

const zipFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  description: z.string().trim().optional(),
});

export function InstallPackForm({
  onDone,
  onCancel,
}: {
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [mode, setMode] = useState<"git" | "zip">("git");

  const gitForm = useForm<z.infer<typeof gitFormSchema>>({
    resolver: zodResolver(gitFormSchema),
    defaultValues: { url: "", ref: "", keepSynced: false, name: "", description: "" },
  });

  const zipForm = useForm<z.infer<typeof zipFormSchema>>({
    resolver: zodResolver(zipFormSchema),
    defaultValues: { name: "", description: "" },
  });

  const [{ files }, { openFileDialog, getInputProps, removeFile, clearErrors }] = useFileUpload({
    accept: ".zip",
    multiple: false,
    maxSize: 50 * 1024 * 1024, // 50MB
    maxFiles: 1,
    onError: (errors) => {
      for (const err of errors) toast.error(err);
    },
  });

  const gitMutation = useInstallGitPack();
  const zipMutation = useUploadZipPack();

  const onSubmitGit = async (values: z.infer<typeof gitFormSchema>) => {
    try {
      await gitMutation.mutateAsync({
        name: values.name,
        description: values.description ?? "",
        url: values.url,
        ref: values.ref || undefined,
        keepSynced: values.keepSynced,
      });
      toast.success(`Importing "${values.name}"...`);
      gitForm.reset();
      onDone();
    } catch (e) {
      toast.error(`Failed: ${(e as Error).message}`);
    }
  };

  const onSubmitZip = async (values: z.infer<typeof zipFormSchema>) => {
    if (files.length === 0) {
      toast.error("Please select a zip file");
      return;
    }
    try {
      await zipMutation.mutateAsync({
        name: values.name,
        description: values.description ?? "",
        file: files[0]!.file as File,
      });
      toast.success(`Importing "${values.name}"...`);
      zipForm.reset();
      clearFileInput();
      onDone();
    } catch (e) {
      toast.error(`Failed: ${(e as Error).message}`);
    }
  };

  function clearFileInput() {
    for (const f of files) removeFile(f.id);
    clearErrors();
  }

  return (
    <div className="space-y-4">
      <Select value={mode} onValueChange={(v) => setMode((v ?? "git") as "git" | "zip")}>
        <SelectTrigger size="default" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="git">Git Import</SelectItem>
          <SelectItem value="zip">ZIP Import</SelectItem>
        </SelectContent>
      </Select>

      {mode === "git" ? (
        <Form {...gitForm}>
          <form onSubmit={gitForm.handleSubmit(onSubmitGit)} className="space-y-3">
            <Text as="p" className="text-xs text-(--mute)">
              Provide a Git repository URL; the system pulls every skill directory containing
              SKILL.md into one new pack. /tree/branch/path URLs are supported.
            </Text>
            <FormField
              control={gitForm.control}
              name="url"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <Input
                      {...field}
                      placeholder="https://git.host/org/repo.git, or .../tree/branch/path"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={gitForm.control}
              name="ref"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <Input
                      {...field}
                      placeholder="Branch name (leave empty for repo default or URL branch)"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={gitForm.control}
              name="keepSynced"
              render={({ field }) => (
                <FormItem>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={(checked) => field.onChange(checked === true)}
                    />
                    Keep synced with Git repository (manual sync still available)
                  </label>
                </FormItem>
              )}
            />
            <FormField
              control={gitForm.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <Input {...field} placeholder="Skill pack name" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={gitForm.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <Textarea {...field} placeholder="Skill pack description (optional)" rows={3} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormFooter
              cancel={onCancel}
              submitLabel={gitMutation.isPending ? "Importing…" : "Import"}
              disabled={gitMutation.isPending}
            />
          </form>
        </Form>
      ) : (
        <Form {...zipForm}>
          <form onSubmit={zipForm.handleSubmit(onSubmitZip)} className="space-y-3">
            <Text as="p" className="text-xs text-(--mute)">
              Select a ZIP file; the system validates one or more skill directories inside and
              imports them into one new pack.
            </Text>
            <input {...getInputProps()} />
            {files.length === 0 ? (
              <Button type="button" variant="outline" onClick={openFileDialog}>
                <Upload className="size-4" />
                Choose ZIP
              </Button>
            ) : (
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{files[0]!.file.name}</div>
                  <div className="text-xs text-(--mute)">
                    {formatBytes((files[0]!.file as File).size)}
                  </div>
                </div>
                <Button type="button" variant="ghost" size="sm" onClick={clearFileInput}>
                  Remove
                </Button>
              </div>
            )}
            <FormField
              control={zipForm.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <Input {...field} placeholder="Skill pack name" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={zipForm.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <Textarea {...field} placeholder="Skill pack description (optional)" rows={3} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormFooter
              cancel={onCancel}
              submitLabel={zipMutation.isPending ? "Importing…" : "Import"}
              disabled={zipMutation.isPending || files.length === 0}
            />
          </form>
        </Form>
      )}
    </div>
  );
}

function FormFooter({
  cancel,
  submitLabel,
  disabled,
}: {
  cancel?: () => void;
  submitLabel: string;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center justify-end gap-2 border-t border-(--hairline) pt-3">
      {cancel && (
        <Button type="button" variant="ghost" onClick={cancel}>
          Cancel
        </Button>
      )}
      <Button type="submit" disabled={disabled}>
        {submitLabel}
      </Button>
    </div>
  );
}
