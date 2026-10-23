fn main() {
    // `DECK_NODE_MAJOR` is read with `env!`, which cargo does not otherwise treat
    // as an input: without this, packing a second plugin that declares a
    // different Node major would reuse the first one's binary.
    println!("cargo:rerun-if-env-changed=DECK_NODE_MAJOR");
}
