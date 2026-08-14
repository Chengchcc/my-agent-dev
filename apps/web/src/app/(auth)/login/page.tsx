"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";

export const dynamic = "force-dynamic";

const formSchema = z.object({
  password: z.string().min(1, "Password is required"),
});

type FormValues = z.infer<typeof formSchema>;

export default function LoginPage() {
  return (
    <Suspense
      fallback={<div className="flex min-h-screen items-center justify-center bg-(--canvas)" />}
    >
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const errorParam = searchParams.get("error");
  const [serverError, setServerError] = useState<string | null>(
    errorParam === "invalid_password"
      ? "Invalid password. Please try again."
      : errorParam
        ? "Sign in failed. Please try again."
        : null,
  );

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { password: "" },
  });

  async function onSubmit(values: FormValues) {
    setServerError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: values.password }),
      });
      if (res.status === 401) {
        const body = await res.json().catch(() => ({ error: "Invalid password" }));
        setServerError(
          body.error === "invalid_password"
            ? "Invalid password. Please try again."
            : "Sign in failed. Please try again.",
        );
        return;
      }
      // Successful login — navigate to trigger cookie processing
      router.push("/work");
    } catch {
      setServerError("Network error. Please try again.");
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-(--canvas)">
      <div className="fixed top-0 inset-x-0 h-0.5 bg-(--primary)" />

      <div className="w-full max-w-sm px-8 animate-fade-in">
        <p className="text-xs tracking-kicker uppercase text-(--mute) mb-8 font-sans font-semibold">
          Observatory
        </p>

        <h1 className="text-3xl/tight font-normal text-(--ink-strong) mb-2 font-sans">
          Agent
          <br />
          Workspace
        </h1>

        <p className="text-sm text-(--body) mb-6">A terminal for working with agents</p>

        {serverError && (
          <div className="mb-6 p-3 rounded border border-destructive/30 bg-destructive/10 text-sm text-destructive">
            {serverError}
          </div>
        )}

        <Form {...form}>
          <form method="POST" onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <label className="text-[10px] tracking-kicker uppercase text-(--mute) block mb-2 font-sans font-semibold">
                    Password
                  </label>
                  <FormControl>
                    <Input
                      {...field}
                      type="password"
                      autoComplete="current-password"
                      placeholder="••••••••"
                      className="w-full bg-transparent border-0 border-b border-(--hairline)
                                 px-0 py-3 text-(--ink) text-base
                                 placeholder:text-(--mute)
                                 focus:outline-none focus:border-(--primary) focus-visible:ring-0
                                 transition-colors duration-200"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <Button type="submit" disabled={form.formState.isSubmitting} className="w-full">
              {form.formState.isSubmitting ? "Signing in..." : "Enter →"}
            </Button>
          </form>
        </Form>

        <div className="mt-12 pt-6 border-t border-(--hairline)">
          <p className="text-[10px] tracking-kicker text-(--mute)">
            my-agent-team &copy; {new Date().getFullYear()}
          </p>
        </div>
      </div>
    </div>
  );
}
