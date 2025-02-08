import { Search } from "lucide-react"
export default function Main() {
	return (
		<>
			<h1 className="text-2xl tracking-wide font-bold text-white text-center">Search for Recipes</h1>
			<label className="mx-auto mt-5 input input-bordered w-full max-w-[70%] flex items-center ">
			<input type="text" placeholder="Type here" className="w-full" />
			<Search />				
			</label>
		</>
	)
}
