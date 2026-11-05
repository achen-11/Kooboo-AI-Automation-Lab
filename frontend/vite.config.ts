import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
export default defineConfig({root:"frontend",base:"/",plugins:[vue()],build:{outDir:"dist",emptyOutDir:true,manifest:true}});
