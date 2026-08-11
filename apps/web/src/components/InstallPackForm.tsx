"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Upload } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useInstallGitPack, useUploadZipPack } from "@/features/skill-packs/hooks";
import { formatBytes, useFileUpload } from "@/hooks/use-file-upload";

const gitFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  description: z.string().trim().min(1, "Description is required"),
  url: z.string().trim().min(1, "URL is required"),
  ref: z.string().trim().optional(),
});

const zipFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  description: z.string().trim().min(1, "Description is required"),
});

export function InstallPackForm({ onDone }: { onDone: () => void }) {
  const [tab, setTab] = useState<"git" | "zip">("git");

  const gitForm = useForm<z.infer<typeof gitFormSchema>>({
    resolver: zodResolver(gitFormSchema),
    defaultValues: { name: "", description: "", url: "", ref: "" },
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
      await gitMutation.mutateAsync(values);
      toast.success(`Installing "${values.name}"...`);
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
        description: values.description,
        file: files[0]!.file as File,
      });
      toast.success(`Installing "${values.name}"...`);
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
    <Tabs value={tab} onValueChange={(v) => setTab(v as "git" | "zip")}>
      <TabsList className="mb-4">
        <TabsTrigger value="git">From Git</TabsTrigger>
        <TabsTrigger value="zip">Upload ZIP</TabsTrigger>
      </TabsList>

      <TabsContent value="git" className="w-full min-w-0">
        <Form {...gitForm}>
          <form onSubmit={gitForm.handleSubmit(onSubmitGit)} className="space-y-3">
            <FormField
              control={gitForm.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="My Skill Pack" {...field} />
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
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Input placeholder="What this pack contains" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={gitForm.control}
              name="url"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Git URL</FormLabel>
                  <FormControl>
                    <Input placeholder="https://github.com/..." {...field} />
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
                  <FormLabel>Branch / Tag (optional)</FormLabel>
                  <FormControl>
                    <Input placeholder="main" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit" disabled={gitMutation.isPending}>
              {gitMutation.isPending ? "Installing…" : "Install from Git"}
            </Button>
          </form>
        </Form>
      </TabsContent>

      <TabsContent value="zip" className="w-full min-w-0">
        <Form {...zipForm}>
          <form onSubmit={zipForm.handleSubmit(onSubmitZip)} className="space-y-3">
            <FormField
              control={zipForm.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="My Skill Pack" {...field} />
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
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Input placeholder="What this pack contains" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* File upload zone */}
            <FormItem>
              <FormLabel>ZIP File</FormLabel>
              <div className="flex flex-col gap-2">
                <input {...getInputProps()} />
                {files.length === 0 ? (
                  <button
                    type="button"
                    onClick={openFileDialog}
                    className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-muted-foreground/25 p-6 text-center transition-colors hover:border-muted-foreground/50 hover:bg-muted/50"
                  >
                    <Upload className="h-8 w-8 text-muted-foreground" />
                    <div className="text-sm text-muted-foreground">
                      <span className="font-medium text-primary">Click to upload</span> or drag and
                      drop
                    </div>
                    <div className="text-xs text-muted-foreground">ZIP file up to 50MB</div>
                  </button>
                ) : (
                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex-shrink-0 rounded bg-muted p-2">
                        <Upload className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{files[0]!.file.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {formatBytes((files[0]!.file as File).size)}
                        </div>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={clearFileInput}
                      className="text-muted-foreground hover:text-destructive shrink-0"
                    >
                      Remove
                    </Button>
                  </div>
                )}
              </div>
            </FormItem>

            <Button type="submit" disabled={zipMutation.isPending || files.length === 0}>
              {zipMutation.isPending ? "Installing…" : "Install from ZIP"}
            </Button>
          </form>
        </Form>
      </TabsContent>
    </Tabs>
  );
}
