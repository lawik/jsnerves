# Make the firmware updates the page offers: fwup delta files between firmware
# versions, with fwup_delta, and updates/index.json that lists them.
#
#   elixir tools/make_deltas.exs <base.fw> <other.fw> [more.fw ...]
#
# The first firmware is the one in the disk image (the base). A delta is made
# from every firmware to every other one, so that any of them can be reached
# from whichever runs. Needs xdelta3, zip and unzip, as fwup_delta does.
# FWUP_DELTA_PATH points at a checkout of fwup_delta instead of Hex.
Mix.install([
  case System.get_env("FWUP_DELTA_PATH") do
    nil -> {:fwup_delta, "~> 0.1"}
    path -> {:fwup_delta, path: path}
  end
])

defmodule Deltas do
  def version(fw) do
    {meta, 0} = System.cmd("fwup", ["-m", "-i", fw])
    [_, version] = Regex.run(~r/^meta-version="?([^"\n]+)"?$/m, meta)
    version
  end
end

firmwares = System.argv()
if length(firmwares) < 2, do: raise("usage: make_deltas.exs <base.fw> <other.fw> [more.fw ...]")

out = Path.expand("../updates", __DIR__)
File.rm_rf!(out)
File.mkdir_p!(out)
versions = Enum.map(firmwares, &{Deltas.version(&1), &1})

deltas =
  for {from, source} <- versions, {to, target} <- versions, from != to do
    {:ok, delta} = FwupDelta.generate({:local, source}, {:local, target})
    name = "#{from}-to-#{to}.fw"
    File.cp!(delta.filepath, Path.join(out, name))
    IO.puts("#{name}: #{delta.size} bytes (the whole firmware is #{delta.target_size})")
    %{from: from, to: to, file: name, size: delta.size}
  end

index = %{base: elem(hd(versions), 0), versions: Enum.map(versions, &elem(&1, 0)), deltas: deltas}
File.write!(Path.join(out, "index.json"), JSON.encode!(index) <> "\n")
